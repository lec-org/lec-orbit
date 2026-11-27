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
  prerelease?: boolean;
  published_at?: string | null;
  created_at?: string | null;
}

interface GitHubPullItem {
  merged_at?: string | null;
  updated_at?: string | null;
  user?: { login?: string | null; type?: string | null } | null;
}

interface GitHubSearchIssuesResponse {
  items?: Array<{
    user?: { login?: string | null; type?: string | null } | null;
    pull_request?: { merged_at?: string | null } | null;
  }>;
}

export interface ReleaseContributorWindow {
  tagName: string;
  publishedAt: Date;
  contributorLogins: string[];
}

/**
 * 纯函数：按 Release 发布时间窗口将已合并 PR 归属到各个版本。
 * 每个版本 R_i 的窗口为 (R_{i-1}.publishedAt, R_i.publishedAt]；
 * 首个版本 R_0 若传入 earliestLowerBoundExclusive（例如数据库中更早的 Release），则以之为严格下界避免历史老 PR 污染。
 */
export function attributeMergedPrsToReleases(
  releases: ReadonlyArray<{ tagName: string; publishedAt: Date }>,
  mergedPrs: ReadonlyArray<{ mergedAt: Date; authorLogin: string }>,
  options?: { earliestLowerBoundExclusive?: Date | null },
): ReleaseContributorWindow[] {
  const sortedReleases = [...releases]
    .filter((r) => r.tagName && !Number.isNaN(r.publishedAt.getTime()))
    .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());

  const firstLowerMs =
    options?.earliestLowerBoundExclusive &&
    !Number.isNaN(options.earliestLowerBoundExclusive.getTime())
      ? options.earliestLowerBoundExclusive.getTime()
      : Number.NEGATIVE_INFINITY;

  return sortedReleases.map((rel, idx) => {
    const prevMs = idx > 0 ? sortedReleases[idx - 1].publishedAt.getTime() : firstLowerMs;
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

  private getConfiguredRepo(): string {
    return (this.cfg.orbitGithubRepo || 'lec-org/lec-orbit').trim();
  }

  private parseValidReleases(rawReleases: GitHubReleaseItem[]): Array<{ tagName: string; publishedAt: Date }> {
    return (Array.isArray(rawReleases) ? rawReleases : [])
      .filter(
        (r) =>
          !r.draft &&
          !r.prerelease &&
          typeof r.tag_name === 'string' &&
          r.tag_name.trim().length > 0,
      )
      .map((r) => {
        const ts = r.published_at || r.created_at || '';
        return {
          tagName: r.tag_name!.trim(),
          publishedAt: new Date(ts),
        };
      })
      .filter((r) => !Number.isNaN(r.publishedAt.getTime()));
  }

  /** 优先使用 GitHub Search API (is:pr is:merged) 拉取纯已合并 PR，失败时回退 /pulls?state=closed。 */
  private async fetchMergedPrs(
    repo: string,
    earliestLowerBoundExclusive: Date | null,
  ): Promise<Array<{ mergedAt: Date; authorLogin: string }>> {
    const mergedPrs: Array<{ mergedAt: Date; authorLogin: string }> = [];
    const sinceFilter = earliestLowerBoundExclusive
      ? ` merged:>=${earliestLowerBoundExclusive.toISOString().slice(0, 10)}`
      : '';
    const searchQuery = encodeURIComponent(`repo:${repo} is:pr is:merged${sinceFilter}`);

    try {
      for (let page = 1; page <= 3; page += 1) {
        const payload = await this.fetchJson<GitHubSearchIssuesResponse>(
          `https://api.github.com/search/issues?q=${searchQuery}&sort=updated&order=desc&per_page=100&page=${page}`,
        );
        const items = Array.isArray(payload?.items) ? payload.items : [];
        if (items.length === 0) break;
        for (const item of items) {
          const mergedAtRaw = item.pull_request?.merged_at;
          if (!mergedAtRaw || !item.user?.login) continue;
          if (item.user.type && item.user.type.toLowerCase() === 'bot') continue;
          const mergedAt = new Date(mergedAtRaw);
          if (Number.isNaN(mergedAt.getTime())) continue;
          mergedPrs.push({
            mergedAt,
            authorLogin: item.user.login.trim().toLowerCase(),
          });
        }
        if (items.length < 100) break;
      }
      return mergedPrs;
    } catch (err) {
      this.logger.warn(
        `Search API 拉取已合并 PR 失败，回退 pulls 接口: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const fallback: Array<{ mergedAt: Date; authorLogin: string }> = [];
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
        fallback.push({
          mergedAt,
          authorLogin: pr.user.login.trim().toLowerCase(),
        });
      }
      if (rawPulls.length < 100) break;
    }
    return fallback;
  }

  /** 拉取仓库近期正式 Release（排除 draft/prerelease）与已合并 PR，按版本窗口归属后原子写入数据库。 */
  async syncReleaseContributors(): Promise<{ syncedReleases: number }> {
    if (this.syncing) return { syncedReleases: 0 };
    const repo = this.getConfiguredRepo();
    if (!repo || !repo.includes('/')) return { syncedReleases: 0 };

    this.syncing = true;
    try {
      const rawReleases = await this.fetchJson<GitHubReleaseItem[]>(
        `https://api.github.com/repos/${repo}/releases?per_page=30`,
      );
      const validReleases = this.parseValidReleases(rawReleases).sort(
        (a, b) => a.publishedAt.getTime() - b.publishedAt.getTime(),
      );

      if (validReleases.length === 0) {
        return { syncedReleases: 0 };
      }

      const oldestFetched = validReleases[0]!;
      const fetchedTagSet = new Set(validReleases.map((r) => r.tagName));

      // 若存在比当前页更早的历史 Release，找出紧邻的前驱发布时间作为窗口严格下界，避免老 PR 污染首个窗口
      let earliestLowerBoundExclusive: Date | null = null;
      const storedForRepo = await this.releaseRepo.find({
        where: { repo },
        order: { publishedAt: 'DESC' },
      });
      const earlierInDb = storedForRepo.find((row) => {
        if (fetchedTagSet.has(row.tagName)) return false;
        const pub = row.publishedAt instanceof Date ? row.publishedAt : new Date(row.publishedAt);
        return !Number.isNaN(pub.getTime()) && pub.getTime() < oldestFetched.publishedAt.getTime();
      });
      if (earlierInDb) {
        earliestLowerBoundExclusive =
          earlierInDb.publishedAt instanceof Date
            ? earlierInDb.publishedAt
            : new Date(earlierInDb.publishedAt);
      } else if (Array.isArray(rawReleases) && rawReleases.length >= 30) {
        // 第 1 页已满且本地库无更早发版记录：补查第 2 页以锁定前驱版本发布时间
        try {
          const page2Raw = await this.fetchJson<GitHubReleaseItem[]>(
            `https://api.github.com/repos/${repo}/releases?per_page=30&page=2`,
          );
          const olderOnPage2 = this.parseValidReleases(page2Raw)
            .filter(
              (r) =>
                !fetchedTagSet.has(r.tagName) &&
                r.publishedAt.getTime() < oldestFetched.publishedAt.getTime(),
            )
            .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
          if (olderOnPage2[0]) {
            earliestLowerBoundExclusive = olderOnPage2[0].publishedAt;
          }
        } catch {
          // 查第 2 页失败时跳过无下界的首个版本写入，避免历史 PR 污染
        }
      }

      const hasMoreUnboundedHistory =
        Array.isArray(rawReleases) && rawReleases.length >= 30 && !earliestLowerBoundExclusive;
      const mergedPrs = await this.fetchMergedPrs(repo, earliestLowerBoundExclusive);

      const allWindows = attributeMergedPrsToReleases(validReleases, mergedPrs, {
        earliestLowerBoundExclusive,
      });
      const windowsToPersist = hasMoreUnboundedHistory ? allWindows.slice(1) : allWindows;
      const now = new Date();
      for (const w of windowsToPersist) {
        await this.releaseRepo.query(
          `INSERT INTO orbit_release_contributors (repo, tag_name, published_at, contributor_logins, synced_at)
           VALUES ($1, $2, $3, $4::jsonb, $5)
           ON CONFLICT (repo, tag_name) DO UPDATE SET
             published_at = EXCLUDED.published_at,
             contributor_logins = (
               SELECT COALESCE(jsonb_agg(DISTINCT val ORDER BY val), '[]'::jsonb)
               FROM jsonb_array_elements_text(
                 COALESCE(orbit_release_contributors.contributor_logins, '[]'::jsonb) || EXCLUDED.contributor_logins
               ) AS val
             ),
             synced_at = EXCLUDED.synced_at`,
          [repo, w.tagName, w.publishedAt, JSON.stringify(w.contributorLogins), now],
        );
      }

      this.logger.log(`已同步 ${repo} 共 ${windowsToPersist.length} 个版本的 PR 贡献者快照`);
      return { syncedReleases: windowsToPersist.length };
    } finally {
      this.syncing = false;
    }
  }

  /** 读取当前配置仓库按发布时间升序排列的版本贡献者快照列表（按 repo 隔离）。 */
  async listReleaseContributors(): Promise<ReleaseContributorWindow[]> {
    const repo = this.getConfiguredRepo();
    if (!repo) return [];
    const rows = await this.releaseRepo.find({
      where: { repo },
      order: { publishedAt: 'ASC' },
    });
    return rows.map((r) => ({
      tagName: r.tagName,
      publishedAt: r.publishedAt instanceof Date ? r.publishedAt : new Date(r.publishedAt),
      contributorLogins: Array.isArray(r.contributorLogins) ? r.contributorLogins : [],
    }));
  }
}
