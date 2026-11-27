/**
 * GitHub Release & PR 贡献者定时同步服务：
 * - 定时调用 GitHub REST API 同步 Orbit 仓库（默认 lec-org/lec-orbit）的历史 Release 与已合并 PR；
 * - 按版本发布时间窗口归属每个版本的 PR 作者 GitHub login，持久化至 orbit_release_contributors 表；
 * - 为「贡献王」（连续 3 次版本更新参与并提交合并 PR）提供离线可查数据，支持 GITHUB_TOKEN 提升限额。
 */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { APP_CONFIG, type AppConfig } from '../../config/env.config.js';
import { OrbitReleaseContributorEntity } from './entities/orbit-release-contributor.entity.js';

interface GitHubReleaseItem {
  tag_name?: string;
  draft?: boolean;
  published_at?: string | null;
  created_at?: string | null;
}

interface GitHubPullItem {
  merged_at?: string | null;
  updated_at?: string | null;
  user?: { login?: string | null; type?: string | null } | null;
}

export interface ReleaseContributorWindow {
  tagName: string;
  publishedAt: Date;
  contributorLogins: string[];
}

/**
 * 纯函数：按 Release 发布时间窗口将已合并 PR 归属到各个版本。
 * 每个版本 R_i 的窗口为 (R_{i-1}.publishedAt, R_i.publishedAt]（首个版本为 <= R_0.publishedAt）。
 */
export function attributeMergedPrsToReleases(
  releases: ReadonlyArray<{ tagName: string; publishedAt: Date }>,
  mergedPrs: ReadonlyArray<{ mergedAt: Date; authorLogin: string }>,
): ReleaseContributorWindow[] {
  const sortedReleases = [...releases]
    .filter((r) => r.tagName && !Number.isNaN(r.publishedAt.getTime()))
    .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());

  return sortedReleases.map((rel, idx) => {
    const prevMs = idx > 0 ? sortedReleases[idx - 1].publishedAt.getTime() : Number.NEGATIVE_INFINITY;
    const curMs = rel.publishedAt.getTime();
    const logins = new Set<string>();
    for (const pr of mergedPrs) {
      const mMs = pr.mergedAt.getTime();
      if (Number.isNaN(mMs)) continue;
      if (mMs > prevMs && mMs <= curMs) {
        const normalized = pr.authorLogin.trim().toLowerCase();
        if (normalized) logins.add(normalized);
      }
    }
    return {
      tagName: rel.tagName,
      publishedAt: rel.publishedAt,
      contributorLogins: [...logins].sort(),
    };
  });
}

@Injectable()
export class GitHubContributorSyncService implements OnModuleInit {
  private readonly logger = new Logger(GitHubContributorSyncService.name);
  private syncing = false;

  constructor(
    @InjectRepository(OrbitReleaseContributorEntity)
    private readonly releaseRepo: Repository<OrbitReleaseContributorEntity>,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.cfg.nodeEnv === 'test') return;
    // 启动后异步首次同步，不阻塞服务端启动
    void this.syncReleaseContributors().catch((err: unknown) => {
      this.logger.warn(
        `首次同步 GitHub Release 贡献者失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /** 每 6 小时自动调用 GitHub API 刷新发版与合并 PR 贡献者快照。 */
  @Cron('0 */6 * * *')
  async handleScheduledSync(): Promise<void> {
    try {
      await this.syncReleaseContributors();
    } catch (err) {
      this.logger.warn(
        `定时同步 GitHub Release 贡献者失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'lec-orbit-server',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.cfg.githubToken) {
      headers.Authorization = `Bearer ${this.cfg.githubToken}`;
    }
    return headers;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url, {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status} (${url})`);
    }
    return (await res.json()) as T;
  }

  /** 拉取仓库近期 Release 与已合并 PR，按版本窗口归属后写入数据库。 */
  async syncReleaseContributors(): Promise<{ syncedReleases: number }> {
    if (this.syncing) return { syncedReleases: 0 };
    const repo = (this.cfg.orbitGithubRepo || 'lec-org/lec-orbit').trim();
    if (!repo || !repo.includes('/')) return { syncedReleases: 0 };

    this.syncing = true;
    try {
      const rawReleases = await this.fetchJson<GitHubReleaseItem[]>(
        `https://api.github.com/repos/${repo}/releases?per_page=30`,
      );
      const validReleases = (Array.isArray(rawReleases) ? rawReleases : [])
        .filter((r) => !r.draft && typeof r.tag_name === 'string' && r.tag_name.trim())
        .map((r) => {
          const ts = r.published_at || r.created_at || '';
          return {
            tagName: r.tag_name!.trim(),
            publishedAt: new Date(ts),
          };
        })
        .filter((r) => !Number.isNaN(r.publishedAt.getTime()));

      if (validReleases.length === 0) {
        return { syncedReleases: 0 };
      }

      // 分页拉取已关闭 PR（最多 3 页 / 300 条，覆盖足够多历史发版窗口）
      const mergedPrs: Array<{ mergedAt: Date; authorLogin: string }> = [];
      for (let page = 1; page <= 3; page += 1) {
        const rawPulls = await this.fetchJson<GitHubPullItem[]>(
          `https://api.github.com/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`,
        );
        if (!Array.isArray(rawPulls) || rawPulls.length === 0) break;
        for (const pr of rawPulls) {
          if (!pr.merged_at || !pr.user?.login) continue;
          if (pr.user.type && pr.user.type.toLowerCase() === 'bot') continue;
          const mergedAt = new Date(pr.merged_at);
          if (Number.isNaN(mergedAt.getTime())) continue;
          mergedPrs.push({
            mergedAt,
            authorLogin: pr.user.login.trim().toLowerCase(),
          });
        }
        if (rawPulls.length < 100) break;
      }

      const windows = attributeMergedPrsToReleases(validReleases, mergedPrs);
      const now = new Date();
      for (const w of windows) {
        const existing = await this.releaseRepo.findOne({ where: { tagName: w.tagName } });
        // 合并历史已入库的贡献者集合，防止分页窗口外较早发版的贡献者被清空
        const mergedLogins = new Set<string>([
          ...(Array.isArray(existing?.contributorLogins) ? existing.contributorLogins : []),
          ...w.contributorLogins,
        ]);
        await this.releaseRepo.save({
          tagName: w.tagName,
          repo,
          publishedAt: w.publishedAt,
          contributorLogins: [...mergedLogins].sort(),
          syncedAt: now,
        });
      }

      this.logger.log(`已同步 ${repo} 共 ${windows.length} 个版本的 PR 贡献者快照`);
      return { syncedReleases: windows.length };
    } finally {
      this.syncing = false;
    }
  }

  /** 读取按发布时间升序排列的版本贡献者快照列表。 */
  async listReleaseContributors(): Promise<ReleaseContributorWindow[]> {
    const rows = await this.releaseRepo.find({
      order: { publishedAt: 'ASC' },
    });
    return rows.map((r) => ({
      tagName: r.tagName,
      publishedAt: r.publishedAt instanceof Date ? r.publishedAt : new Date(r.publishedAt),
      contributorLogins: Array.isArray(r.contributorLogins) ? r.contributorLogins : [],
    }));
  }
}
