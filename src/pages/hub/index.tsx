/**
 * Orbit「工坊（Hub）」页面：
 * - 统一承载工作室内部小程序与小游戏（支持 Web / Cocos / Unity / Godot）
 * - 支持三态启动与切换：右侧伴随栏（sidepanel）、主区全幅（workspace）、独立窗口（standalone）
 * - 内置本地目录/DevServer 实时调试台 + ZIP 上传（<=100MB RustFS）& GitHub Releases 大包导入 + 队长审核流
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from 'react';
import {
  Button,
  Dialog,
  Empty,
  Input,
  Message,
  SegmentedControl,
  Tag,
} from '@lec-space/liquidglass';
import { Search } from '@lec-space/icons';
import {
  ArrowLeft,
  BarChart3,
  Bug,
  CheckCircle2,
  Cloud,
  Code2,
  ExternalLink,
  FolderOpen,
  Gamepad2,
  GitBranch,
  HardDrive,
  Layers,
  PanelRight,
  Play,
  Radio,
  RefreshCw,
  ShieldCheck,
  Star,
  Trash2,
  Trophy,
  Upload,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import {
  engineDisplayLabel,
  formatBytesCompact,
  modeDisplayLabel,
  OrbitAppManifestSchema,
  type MiniAppCatalogItem,
  type MiniAppDisplayMode,
  type MiniAppEngine,
  type OrbitAppManifest,
  type RunningMiniAppState,
} from '@shared/miniapp';
import { MemberMention } from '@/components/MemberMention';
import { MemberProfileDialog, type MemberProfileSeed } from '@/components/MemberProfileDialog';
import { getOrbitClient, isDesktopRuntime } from '@/services/orbitClient';
import { orbitServerApi, type MiniAppLeaderboardItem } from '@/services/orbitServerApi';
import { notifyToast } from '@/services/orbitToast';
import { useOrbitStore } from '@/stores/useOrbitStore';
import {
  MiniAppEngagementDialog,
  type MiniAppEngagementTarget,
} from './MiniAppEngagementDialog';
import {
  MiniAppFunctionsDialog,
  type MiniAppFunctionsDialogTarget,
} from './MiniAppFunctionsDialog';
import styles from './Hub.module.css';

type HubFilterTab = 'all' | 'miniapp' | 'minigame' | 'mine' | 'pending';
type LeaderboardSort = 'composite' | 'rating' | 'plays';
type LeaderboardTypeFilter = 'all' | 'minigame' | 'miniapp';
type EngineFilter = 'all' | MiniAppEngine;

type WorkshopWork = { appId: string; name: string };
type WorkshopAction = WorkshopWork & (
  | { type: 'withdraw' | 'resubmit'; versionId: string; version: string }
  | { type: 'suspend' }
  | { type: 'delete' }
);

const workshopActionLabels = {
  withdraw: { title: '撤回送审', confirm: '确认撤回', success: '已撤回送审' },
  resubmit: { title: '重新送审', confirm: '确认送审', success: '已重新送审' },
  suspend: { title: '下架作品', confirm: '确认下架', success: '作品已下架' },
  delete: { title: '删除游戏', confirm: '确认删除', success: '游戏已从工坊移除' },
};

function describeWorkshopAction(action: WorkshopAction): string {
  if (action.type === 'delete') {
    return `确认后，《${action.name}》将从工坊列表移除。历史版本和云存档会保留，你可以用同一个作品 ID 重新上传。`;
  }
  if (action.type === 'suspend') {
    return `下架后，其他普通成员将无法从工坊打开《${action.name}》。待审更新会同时撤回，历史版本和存档会保留。`;
  }
  const build = `《${action.name}》v${action.version}`;
  return action.type === 'withdraw'
    ? `撤回后，${build} 将移出待审核队列。你可以从「我的作品」重新送审或上传新版本。`
    : `将 ${build} 的原构建包提交给队长审核。`;
}

function formatPlayingAgo(iso: string): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (!Number.isFinite(diffSec) || diffSec < 60) return '刚刚开始';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `已玩 ${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  return `已玩 ${hours} 小时 ${mins % 60} 分`;
}

function getPendingRelease(item?: MiniAppCatalogItem) {
  // Older servers expose only the latest version.
  if (item?.pendingVersion !== undefined) return item.pendingVersion;
  const latest = item?.latestVersion;
  return latest?.channel === 'release' && latest.status === 'pending' ? latest : undefined;
}

function getCardVersion(item: MiniAppCatalogItem, tab: HubFilterTab) {
  if (tab === 'pending') return getPendingRelease(item);
  if (tab === 'mine') return item.latestVersion ?? item.activeVersion;
  return item.activeVersion ?? item.latestVersion;
}

interface UnifiedHubCard {
  appId: string;
  name: string;
  type: 'miniapp' | 'minigame';
  engine: MiniAppEngine;
  version: string;
  description: string;
  tags: string[];
  defaultMode: MiniAppDisplayMode;
  supportedModes: MiniAppDisplayMode[];
  crossOriginIsolated: boolean;
  isBuiltin: boolean;
  isInstalled: boolean;
  installedSizeBytes?: number;
  iconUrl?: string;
  ownerName?: string;
  playCount?: number;
  catalogItem?: MiniAppCatalogItem;
}

function MiniAppWorkspaceHost({ app }: { app: RunningMiniAppState }): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const orbit = getOrbitClient();
    const syncBounds = () => {
      const el = viewportRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      void orbit.hub.setWorkspaceBounds({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      });
    };

    syncBounds();
    const observer = new ResizeObserver(syncBounds);
    if (viewportRef.current) observer.observe(viewportRef.current);
    window.addEventListener('resize', syncBounds);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncBounds);
      void orbit.hub.setWorkspaceBounds({ x: 0, y: 0, width: 0, height: 0 });
    };
  }, [app.appId]);

  return (
    <div className={styles.workspaceWrap}>
      <header className={styles.workspaceBar}>
        <div className={styles.workspaceLeft}>
          <button
            type="button"
            className={styles.backBtn}
            onClick={() => void getOrbitClient().hub.close(app.appId)}
          >
            <ArrowLeft size={14} />
            <span>返回工坊</span>
          </button>
          <span className={styles.workspaceTitle}>{app.name}</span>
          <Tag tone="info">{engineDisplayLabel(app.engine)}</Tag>
          <span className={styles.workspaceVer}>v{app.version}</span>
          {app.crossOriginIsolated && (
            <Tag tone="success" icon={<ShieldCheck size={11} />}>
              COOP/COEP
            </Tag>
          )}
        </div>
        <div className={styles.workspaceActions}>
          {app.supportedModes.includes('sidepanel') && (
            <Button
              variant="glass"
              size="small"
              icon={<PanelRight size={13} />}
              onClick={() => void getOrbitClient().hub.switchMode(app.appId, 'sidepanel')}
            >
              贴到右侧栏
            </Button>
          )}
          {app.supportedModes.includes('standalone') && (
            <Button
              variant="glass"
              size="small"
              icon={<ExternalLink size={13} />}
              onClick={() => void getOrbitClient().hub.switchMode(app.appId, 'standalone')}
            >
              弹出独立窗
            </Button>
          )}
          <Button
            variant="glass"
            size="small"
            icon={<RefreshCw size={13} />}
            onClick={() => void getOrbitClient().hub.reload(app.appId)}
          >
            刷新
          </Button>
          <Button
            variant="glass"
            size="small"
            icon={<Bug size={13} />}
            onClick={() => void getOrbitClient().hub.openDevTools(app.appId)}
          >
            调试
          </Button>
        </div>
      </header>

      <div ref={viewportRef} className={styles.workspaceViewport}>
        {(!isDesktopRuntime() || app.overlayHidden || app.error) && (
          <div className={styles.workspacePlaceholder}>
            <p className={styles.placeholderTitle}>
              {app.error
                ? app.error
                : app.overlayHidden
                  ? '主区应用已临时避让当前弹窗'
                  : '工坊容器仅在 Orbit 桌面客户端运行'}
            </p>
            <p className={styles.placeholderSub}>
              {app.overlayHidden ? '关闭弹窗后自动恢复原画面' : `${app.name} · v${app.version}`}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export function HubPage(): JSX.Element {
  const auth = useOrbitStore((s) => s.auth);
  const hubRuntime = useOrbitStore((s) => s.hubRuntime);
  const hubBuiltins = useOrbitStore((s) => s.hubBuiltins);
  const hubInstalled = useOrbitStore((s) => s.hubInstalled);
  const hubCatalog = useOrbitStore((s) => s.hubCatalog);
  const hubPresence = useOrbitStore((s) => s.hubPresence);
  const hubLoading = useOrbitStore((s) => s.hubLoading);
  const hubError = useOrbitStore((s) => s.hubError);
  const refreshHubData = useOrbitStore((s) => s.refreshHubData);
  const refreshHubLocal = useOrbitStore((s) => s.refreshHubLocal);
  const refreshHubPresence = useOrbitStore((s) => s.refreshHubPresence);
  const pushOverlay = useOrbitStore((s) => s.pushOverlay);
  const popOverlay = useOrbitStore((s) => s.popOverlay);

  const [tab, setTab] = useState<HubFilterTab>('all');
  const [engineFilter, setEngineFilter] = useState<EngineFilter>('all');
  const [query, setQuery] = useState('');
  const [launchingId, setLaunchingId] = useState<string | null>(null);

  // 本地调试弹窗状态
  const [devOpen, setDevOpen] = useState(false);
  const [devTab, setDevTab] = useState<'dir' | 'url'>('dir');
  const [pickedDirPath, setPickedDirPath] = useState('');
  const [pickedDirManifest, setPickedDirManifest] = useState<OrbitAppManifest | null>(null);
  const [devDirMode, setDevDirMode] = useState<MiniAppDisplayMode>('sidepanel');
  const [devUrl, setDevUrl] = useState('http://localhost:5173');
  const [devUrlName, setDevUrlName] = useState('本地热重载调试');
  const [devUrlAppId, setDevUrlAppId] = useState('dev-local-preview');
  const [devUrlMode, setDevUrlMode] = useState<MiniAppDisplayMode>('sidepanel');
  const [devUrlIso, setDevUrlIso] = useState(false);

  // 上传 / GitHub 导入弹窗状态
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadTarget, setUploadTarget] = useState<WorkshopWork | null>(null);
  const [uploadSource, setUploadSource] = useState<'zip' | 'github'>('zip');
  const [zipInfo, setZipInfo] = useState<{
    filePath: string;
    fileName: string;
    sizeBytes: number;
    manifest: OrbitAppManifest;
  } | null>(null);
  const [uploadChannel, setUploadChannel] = useState<'release' | 'preview'>('release');
  const [workshopAction, setWorkshopAction] = useState<WorkshopAction | null>(null);
  const [workshopActionSubmitting, setWorkshopActionSubmitting] = useState(false);
  const [workshopActionError, setWorkshopActionError] = useState('');
  const [uploadChangelog, setUploadChangelog] = useState('');
  const [directPublish, setDirectPublish] = useState(false);
  const [uploadSubmitting, setUploadSubmitting] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);

  // GitHub 导入字段
  const [ghUrl, setGhUrl] = useState('');
  const [ghSha256, setGhSha256] = useState('');
  const [ghManifestText, setGhManifestText] = useState('');

  // 托管云函数工作台弹窗（源码审查 / Secrets / 日志）
  const [fnDialogTarget, setFnDialogTarget] = useState<MiniAppFunctionsDialogTarget | null>(null);
  // 作品互动统计 & 评分弹窗（全员可看谁玩过）
  const [engagementTarget, setEngagementTarget] = useState<MiniAppEngagementTarget | null>(null);
  // 点击作者或玩家 Mention 弹出的工作室成员名片
  const [profileSeed, setProfileSeed] = useState<MemberProfileSeed | null>(null);
  // 排行榜状态
  const [leaderboardSort, setLeaderboardSort] = useState<LeaderboardSort>('composite');
  const [leaderboardType, setLeaderboardType] = useState<LeaderboardTypeFilter>('all');
  const [leaderboardItems, setLeaderboardItems] = useState<MiniAppLeaderboardItem[]>([]);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const prevRunningCountRef = useRef<number>(hubRuntime.apps.length);

  const loadLeaderboard = async (sort: LeaderboardSort, type: LeaderboardTypeFilter) => {
    if (!auth.authenticated) return;
    setLeaderboardLoading(true);
    try {
      const res = await orbitServerApi.getMiniAppLeaderboard({ sort, type });
      setLeaderboardItems(res.items);
    } catch {
      // 忽略排行榜偶发错误
    } finally {
      setLeaderboardLoading(false);
    }
  };

  useEffect(() => {
    void refreshHubData();
    void refreshHubPresence();
    // 定期同步在线在玩状态，确保「此刻谁在玩」时长与人员实时准确
    const timer = window.setInterval(() => {
      void refreshHubPresence();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [refreshHubData, refreshHubPresence]);

  // 右侧排行榜常驻展示，随排序维度或登录状态自动刷新
  useEffect(() => {
    void loadLeaderboard(leaderboardSort, leaderboardType);
  }, [leaderboardSort, leaderboardType, auth.authenticated]);

  // 监测本地运行中作品数变化：当有作品关闭结束一局后，自动刷新目录、在玩动态与右侧排行榜
  useEffect(() => {
    const prev = prevRunningCountRef.current;
    const cur = hubRuntime.apps.length;
    prevRunningCountRef.current = cur;
    if (cur !== prev) {
      const timer = window.setTimeout(() => {
        void refreshHubPresence();
        if (cur < prev) {
          void refreshHubData();
          void loadLeaderboard(leaderboardSort, leaderboardType);
        }
      }, 450);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [hubRuntime.apps.length, refreshHubData, refreshHubPresence, leaderboardSort, leaderboardType]);

  const dialogOpen =
    devOpen ||
    uploadOpen ||
    workshopAction !== null ||
    fnDialogTarget !== null ||
    engagementTarget !== null ||
    profileSeed !== null;
  useEffect(() => {
    if (!dialogOpen) return;
    pushOverlay();
    return () => popOverlay();
  }, [dialogOpen, pushOverlay, popOverlay]);

  const workspaceApp = useMemo(
    () => hubRuntime.apps.find((a) => a.mode === 'workspace') ?? null,
    [hubRuntime.apps],
  );

  const pendingCount = useMemo(
    () => hubCatalog.filter((item) => getPendingRelease(item)).length,
    [hubCatalog],
  );

  const unifiedCards = useMemo<UnifiedHubCard[]>(() => {
    const installedMap = new Map(hubInstalled.map((item) => [item.appId, item]));
    const cards: UnifiedHubCard[] = [];
    const seen = new Set<string>();

    // 1. 线上工坊目录
    for (const item of hubCatalog) {
      const targetVer = getCardVersion(item, tab);
      if (!targetVer) continue;
      seen.add(item.id);
      const inst = installedMap.get(item.id);
      const versionManifest = (tab === 'pending' || tab === 'mine') && targetVer.manifest.id === item.id
        ? targetVer.manifest
        : undefined;
      cards.push({
        appId: item.id,
        name: versionManifest?.name ?? item.name,
        type: versionManifest?.type ?? item.type,
        engine: versionManifest?.engine ?? item.engine,
        version: targetVer.version,
        description: versionManifest?.description ?? item.description,
        tags: versionManifest?.tags ?? item.tags,
        defaultMode: targetVer.manifest.window.defaultMode,
        supportedModes: targetVer.manifest.window.supportedModes,
        crossOriginIsolated: targetVer.manifest.runtime.crossOriginIsolated,
        isBuiltin: false,
        isInstalled: Boolean(inst && inst.version === targetVer.version),
        installedSizeBytes: inst?.sizeBytes ?? targetVer.bundleSize,
        iconUrl: versionManifest ? targetVer.iconUrl ?? item.iconUrl : item.iconUrl,
        ownerName: item.ownerName,
        playCount: item.playCount,
        catalogItem: item,
      });
    }

    // 2. 内置官方种子验证 Demo（零依赖开箱即测）
    for (const builtin of hubBuiltins) {
      if (seen.has(builtin.appId)) continue;
      cards.push({
        appId: builtin.appId,
        name: builtin.manifest.name,
        type: builtin.manifest.type,
        engine: builtin.manifest.engine,
        version: builtin.manifest.version,
        description: builtin.manifest.description,
        tags: builtin.manifest.tags,
        defaultMode: builtin.manifest.window.defaultMode,
        supportedModes: builtin.manifest.window.supportedModes,
        crossOriginIsolated: builtin.manifest.runtime.crossOriginIsolated,
        isBuiltin: true,
        isInstalled: true,
        ownerName: 'LEC 官方示例',
      });
    }

    return cards;
  }, [hubBuiltins, hubCatalog, hubInstalled, tab]);

  const filteredCards = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return unifiedCards.filter((card) => {
      if (tab === 'miniapp' && card.type !== 'miniapp') return false;
      if (tab === 'minigame' && card.type !== 'minigame') return false;
      if (tab === 'mine') {
        if (!card.catalogItem || card.catalogItem.ownerId !== auth.profile?.subject) return false;
      }
      if (tab === 'pending') {
        if (!getPendingRelease(card.catalogItem)) return false;
      }
      if (engineFilter !== 'all' && card.engine !== engineFilter) return false;
      if (!needle) return true;
      const hay = [card.name, card.appId, card.description, card.ownerName ?? '', ...card.tags]
        .join(' ')
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [unifiedCards, tab, engineFilter, query, auth.profile?.subject]);

  if (workspaceApp) {
    return <MiniAppWorkspaceHost app={workspaceApp} />;
  }

  const handleLaunchCard = async (card: UnifiedHubCard, explicitMode?: MiniAppDisplayMode) => {
    setLaunchingId(card.appId);
    try {
      const targetVer = card.catalogItem ? getCardVersion(card.catalogItem, tab) : undefined;

      const launched = await getOrbitClient().hub.launch({
        appId: card.appId,
        mode: explicitMode,
        ...(targetVer && !card.isBuiltin
          ? {
              remoteBundle: {
                version: targetVer.version,
                bundleUrl: targetVer.bundleUrl,
                bundleSha256: targetVer.bundleSha256,
                bundleSize: targetVer.bundleSize,
                manifest: targetVer.manifest,
                iconUrl: card.iconUrl,
              },
            }
          : {}),
      });
      await refreshHubLocal();
      void refreshHubPresence();
      notifyToast({
        tone: 'success',
        title: `已启动「${launched.name}」`,
        description: `当前形态：${modeDisplayLabel(launched.mode)}（关闭后自动结算本局并获得评分机会）`,
      });
    } catch (err) {
      notifyToast({
        tone: 'error',
        title: `启动「${card.name}」失败`,
        description: err instanceof Error ? err.message : '请检查网络或构建包完整性',
      });
    } finally {
      setLaunchingId(null);
    }
  };

  const handlePickLocalDir = async () => {
    const res = await getOrbitClient().hub.pickLocalDir();
    if (res.cancelled) return;
    if (!res.ok || !res.dirPath || !res.manifest) {
      notifyToast({
        tone: 'error',
        title: '目录校验失败',
        description: res.error || '请确认目录根目录存在有效的 orbit.manifest.json',
      });
      return;
    }
    setPickedDirPath(res.dirPath);
    setPickedDirManifest(res.manifest);
    setDevDirMode(res.manifest.window.defaultMode);
  };

  const handleLaunchLocalDir = async () => {
    if (!pickedDirPath) return;
    try {
      const launched = await getOrbitClient().hub.launchLocalDir({
        dirPath: pickedDirPath,
        mode: devDirMode,
      });
      setDevOpen(false);
      notifyToast({
        tone: 'success',
        title: `本地调试已启动：${launched.name}`,
        description: '修改构建产物后点击顶栏刷新按钮即可热重载。',
      });
    } catch (err) {
      notifyToast({
        tone: 'error',
        title: '本地启动失败',
        description: err instanceof Error ? err.message : '未知错误',
      });
    }
  };

  const handleLaunchDevUrl = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const launched = await getOrbitClient().hub.launchDevUrl({
        appId: devUrlAppId.trim() || 'dev-local-preview',
        name: devUrlName.trim() || '本地调试应用',
        url: devUrl.trim(),
        mode: devUrlMode,
        crossOriginIsolated: devUrlIso,
      });
      setDevOpen(false);
      notifyToast({
        tone: 'success',
        title: `已连接本地服务：${launched.name}`,
        description: devUrl.trim(),
      });
    } catch (err) {
      notifyToast({
        tone: 'error',
        title: '连接本地 Dev Server 失败',
        description: err instanceof Error ? err.message : '请确认填写的是 localhost 地址',
      });
    }
  };

  const openUploadDialog = (target: WorkshopWork | null = null) => {
    if (target || uploadTarget) {
      setUploadSource('zip');
      setZipInfo(null);
      setGhUrl('');
      setGhSha256('');
      setGhManifestText('');
      setUploadChangelog('');
      setUploadChannel('release');
      setDirectPublish(false);
    }
    setUploadTarget(target);
    setUploadErr(null);
    setUploadOpen(true);
  };

  const handlePickZip = async () => {
    setUploadErr(null);
    const res = await getOrbitClient().hub.pickZipFile();
    if (res.cancelled) return;
    if (!res.ok || !res.filePath || !res.fileName || !res.manifest || res.sizeBytes == null) {
      setUploadErr(res.error || '构建包校验失败');
      return;
    }
    if (uploadTarget && res.manifest.id !== uploadTarget.appId) {
      setZipInfo(null);
      setUploadErr(`构建包的作品 ID 是 ${res.manifest.id}，请选择 ID 为 ${uploadTarget.appId} 的构建包。`);
      return;
    }
    setZipInfo({
      filePath: res.filePath,
      fileName: res.fileName,
      sizeBytes: res.sizeBytes,
      manifest: res.manifest,
    });
  };

  const handleSubmitUpload = async (e: FormEvent) => {
    e.preventDefault();
    setUploadErr(null);
    setUploadSubmitting(true);
    try {
      const submission = {
        targetAppId: uploadTarget?.appId,
        channel: uploadTarget ? 'release' as const : uploadChannel,
        changelog: uploadChangelog.trim(),
        directPublish: !uploadTarget && auth.isAdmin && directPublish,
      };
      if (uploadSource === 'zip') {
        if (!zipInfo) {
          setUploadErr('请先选择有效的 .zip / .lecapp 构建包');
          return;
        }
        const fileData = await getOrbitClient().hub.readZipFileBase64(zipInfo.filePath);
        const binary = atob(fileData.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: 'application/zip' });
        await orbitServerApi.uploadMiniAppZip({
          blob,
          fileName: fileData.fileName,
          ...submission,
        });
      } else {
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(ghManifestText);
        } catch {
          setUploadErr('请粘贴合法的 orbit.manifest.json 内容');
          return;
        }
        const manifest = OrbitAppManifestSchema.parse(parsedJson);
        if (uploadTarget && manifest.id !== uploadTarget.appId) {
          setUploadErr(`清单的作品 ID 是 ${manifest.id}，请使用 ID 为 ${uploadTarget.appId} 的清单。`);
          return;
        }
        await orbitServerApi.importGitHubMiniApp({
          bundleUrl: ghUrl.trim(),
          bundleSha256: ghSha256.trim(),
          manifest,
          ...submission,
        });
      }

      setUploadOpen(false);
      setZipInfo(null);
      setUploadChangelog('');
      await refreshHubData();
      notifyToast({
        tone: 'success',
        title: submission.directPublish ? '作品已直接发布上架' : uploadTarget ? '新版本已提交审核' : '作品上传成功',
        description:
          submission.directPublish
            ? '全员现在即可在工坊中启动体验。'
            : '已提交至工坊版本队列，队长审核通过后全员可见。',
      });
    } catch (err) {
      setUploadErr(err instanceof Error ? err.message : '上传失败，请检查网络或配置');
    } finally {
      setUploadSubmitting(false);
    }
  };

  const handleReview = async (
    card: UnifiedHubCard,
    decision: 'approve' | 'reject',
  ) => {
    const ver = getPendingRelease(card.catalogItem);
    if (!ver) return;
    try {
      await orbitServerApi.reviewMiniAppVersion(
        card.appId,
        ver.id,
        decision,
        decision === 'reject' ? '请检查运行体验或清单配置后重新提交' : '审核通过',
      );
      await refreshHubData();
      notifyToast({
        tone: decision === 'approve' ? 'success' : 'info',
        title: decision === 'approve' ? `已批准上架《${card.name}》` : `已驳回《${card.name}》`,
      });
    } catch (err) {
      await refreshHubData();
      notifyToast({
        tone: 'error',
        title: '审核操作失败',
        description: err instanceof Error ? err.message : '未知错误',
      });
    }
  };

  const openWorkshopAction = (action: WorkshopAction) => {
    setWorkshopActionError('');
    setWorkshopAction(action);
  };

  const submitWorkshopAction = async () => {
    if (!workshopAction || workshopActionSubmitting) return;
    setWorkshopActionSubmitting(true);
    setWorkshopActionError('');
    try {
      if (workshopAction.type === 'withdraw') {
        await orbitServerApi.withdrawMiniAppVersion(workshopAction.appId, workshopAction.versionId);
      } else if (workshopAction.type === 'resubmit') {
        await orbitServerApi.resubmitMiniAppVersion(workshopAction.appId, workshopAction.versionId);
      } else if (workshopAction.type === 'delete') {
        await orbitServerApi.deleteMiniAppGame(workshopAction.appId);
      } else {
        await orbitServerApi.updateMiniAppStatus(workshopAction.appId, { status: 'suspended' });
      }
      await refreshHubData();
      setWorkshopAction(null);
      notifyToast({
        tone: 'success',
        title: workshopActionLabels[workshopAction.type].success,
      });
    } catch (err) {
      await refreshHubData();
      setWorkshopActionError(err instanceof Error ? err.message : '操作失败，请重试');
    } finally {
      setWorkshopActionSubmitting(false);
    }
  };

  const handleClearCache = async () => {
    const res = await getOrbitClient().hub.clearCache();
    await refreshHubLocal();
    notifyToast({
      tone: 'info',
      title: '已清理工坊本地缓存',
      description: `共释放 ${formatBytesCompact(res.freedBytes)} 磁盘空间`,
    });
  };

  const segItems = [
    { value: 'all', label: '全部' },
    { value: 'miniapp', label: '小程序' },
    { value: 'minigame', label: '小游戏' },
    { value: 'mine', label: '我的作品' },
    ...(auth.isAdmin ? [{ value: 'pending', label: `待审核${pendingCount ? ` (${pendingCount})` : ''}` }] : []),
  ];

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.heading}>工坊</h1>
          <p className={styles.subheading}>
            乐程工作室内部小程序与小游戏容器 · 支持 Web / Cocos / Unity / Godot 与三态无损切换
          </p>
        </div>

        <div className={styles.headerActions}>
          <Button
            variant="glass"
            size="small"
            icon={<Code2 size={14} />}
            onClick={() => setDevOpen(true)}
          >
            本地调试
          </Button>
          <Button
            variant="filled"
            size="small"
            icon={<Upload size={14} />}
            onClick={() => openUploadDialog()}
          >
            上传 / 导入
          </Button>
        </div>
      </header>

      {hubRuntime.apps.length > 0 && (
        <div className={styles.runningStrip}>
          <span className={styles.runningLabel}>运行中 ({hubRuntime.apps.length})</span>
          <div className={styles.runningList}>
            {hubRuntime.apps.map((running) => (
              <div key={running.appId} className={styles.runningPill}>
                <span className={styles.runningDot} />
                <span className={styles.runningName}>{running.name}</span>
                <span className={styles.runningMode}>{modeDisplayLabel(running.mode)}</span>
                {running.mode !== 'sidepanel' && running.supportedModes.includes('sidepanel') && (
                  <button
                    type="button"
                    className={styles.runningBtn}
                    title="贴回右侧栏"
                    onClick={() => void getOrbitClient().hub.switchMode(running.appId, 'sidepanel')}
                  >
                    <PanelRight size={12} />
                  </button>
                )}
                {running.mode !== 'standalone' && running.supportedModes.includes('standalone') && (
                  <button
                    type="button"
                    className={styles.runningBtn}
                    title="弹出独立窗"
                    onClick={() => void getOrbitClient().hub.switchMode(running.appId, 'standalone')}
                  >
                    <ExternalLink size={12} />
                  </button>
                )}
                <button
                  type="button"
                  className={styles.runningBtn}
                  title="关闭"
                  onClick={() => void getOrbitClient().hub.close(running.appId)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={styles.toolbar}>
        <SegmentedControl
          value={tab}
          onValueChange={(v) => setTab(v as HubFilterTab)}
          items={segItems}
        />

        <div className={styles.toolbarRight}>
          <div className={styles.searchWrap}>
            <Input
              variant="fill"
              type="search"
              icon={<Search size={14} />}
              placeholder="搜索应用名称、标签或作者"
              value={query}
              onValueChange={setQuery}
            />
          </div>
          <Button
            variant="glass"
            size="small"
            icon={<RefreshCw size={13} />}
            loading={hubLoading}
            onClick={() => void refreshHubData()}
          >
            刷新
          </Button>
          {hubInstalled.length > 0 && (
            <Button
              variant="glass"
              size="small"
              icon={<Trash2 size={13} />}
              onClick={() => void handleClearCache()}
            >
              清缓存
            </Button>
          )}
        </div>
      </div>

      {hubError && <Message tone="info">{hubError}</Message>}

      {/* 高密度双栏布局：左侧作品列表 + 右侧常驻工坊排行榜 */}
      <div className={styles.hubBoard}>
        <div className={styles.hubCatalogCol}>
          <div className={styles.engineFilters}>
            {(['all', 'web', 'cocos', 'unity', 'godot'] as EngineFilter[]).map((eng) => (
              <button
                key={eng}
                type="button"
                className={`${styles.filterChip} ${engineFilter === eng ? styles.filterChipActive : ''}`}
                onClick={() => setEngineFilter(eng)}
              >
                {eng === 'all' ? '全部引擎' : engineDisplayLabel(eng)}
              </button>
            ))}
          </div>

          {filteredCards.length === 0 ? (
            <div className={styles.emptyWrap}>
              <Empty
                title="暂无符合条件的工坊作品"
                description="点击右上角「本地调试」可直接运行本地小程序/小游戏目录，或点击「上传 / 导入」发布第一个作品。"
              />
            </div>
          ) : (
            <div className={styles.grid}>
          {filteredCards.map((card) => {
            const pendingVersion = getPendingRelease(card.catalogItem);
            const isMyWork = tab === 'mine' && card.catalogItem?.ownerId === auth.profile?.subject;
            const isPublished = card.catalogItem?.status === 'published';
            // Older servers can suspend apps without cancelling their review queue.
            const canManageWork = isMyWork && card.catalogItem?.pendingVersion !== undefined;
            const recoveryVersion = card.catalogItem?.recoveryVersion;
            const canUploadNewVersion = !pendingVersion && (recoveryVersion || card.catalogItem?.status === 'suspended');
            const isReviewTab = auth.isAdmin && tab === 'pending';
            const launchVersion = card.catalogItem ? getCardVersion(card.catalogItem, tab) : undefined;
            const hasCloudFunctions = Boolean(
              launchVersion?.manifest?.functions ||
                launchVersion?.manifest?.permissions?.scopes?.includes('cloud.functions'),
            );
            const opensPendingBuild = pendingVersion && launchVersion?.id === pendingVersion.id;
            const canOpen = !auth.isAdmin || isReviewTab || isMyWork || !opensPendingBuild;
            const running = hubRuntime.apps.find((a) => a.appId === card.appId);
            return (
              <article key={card.appId} className={styles.card}>
                <div className={styles.cardTop}>
                  <div className={styles.cardIcon}>
                    {card.iconUrl ? (
                      <img src={card.iconUrl} alt="" className={styles.cardIconImg} />
                    ) : card.type === 'minigame' ? (
                      <Gamepad2 size={20} />
                    ) : (
                      <Layers size={20} />
                    )}
                  </div>
                  <div className={styles.cardHeadInfo}>
                    <div className={styles.cardTitleRow}>
                      <h3 className={styles.cardTitle}>{card.name}</h3>
                      <span className={styles.cardVersion}>v{card.version}</span>
                    </div>
                    <div className={styles.cardTags}>
                      <Tag tone={card.type === 'minigame' ? 'warning' : 'info'}>
                        {card.type === 'minigame' ? '小游戏' : '小程序'}
                      </Tag>
                      <Tag tone="neutral">{engineDisplayLabel(card.engine)}</Tag>
                      {card.isBuiltin && <Tag tone="success">官方示例</Tag>}
                      {!card.isBuiltin && card.isInstalled && (
                        <Tag tone="success" icon={<HardDrive size={10} />}>
                          已缓存
                        </Tag>
                      )}
                      {card.crossOriginIsolated && (
                        <Tag tone="info" icon={<ShieldCheck size={10} />}>
                          SAB
                        </Tag>
                      )}
                      {hasCloudFunctions && (
                        <Tag tone="info" icon={<Cloud size={10} />}>
                          云函数
                        </Tag>
                      )}
                      {pendingVersion && <Tag tone="warning">待审核</Tag>}
                      {card.catalogItem?.status === 'suspended' && <Tag tone="neutral">已下架</Tag>}
                    </div>
                  </div>
                </div>

                <p className={styles.cardDesc}>
                  {card.description || '工作室成员自研工坊作品，点击即可在隔离沙箱中体验。'}
                </p>

                <div className={styles.cardMeta}>
                  {!card.isBuiltin && card.catalogItem ? (
                    <MemberMention
                      name={card.ownerName || '工作室成员'}
                      avatar={card.catalogItem.ownerAvatar || undefined}
                      size="small"
                      onSelectMember={setProfileSeed}
                    />
                  ) : (
                    <span>{card.ownerName || '工作室成员'}</span>
                  )}
                  <span>
                    默认：{modeDisplayLabel(card.defaultMode)}
                    {card.installedSizeBytes ? ` · ${formatBytesCompact(card.installedSizeBytes)}` : ''}
                  </span>
                </div>

                {!card.isBuiltin && card.catalogItem && (
                  <div className={styles.cardEngagementRow}>
                    <button
                      type="button"
                      className={`${styles.ratingChip} ${
                        (card.catalogItem.myRatingChances ?? 0) > 0 ? styles.ratingChipReady : ''
                      }`}
                      onClick={() =>
                        setEngagementTarget({
                          appId: card.appId,
                          name: card.name,
                          initialTab: 'reviews',
                        })
                      }
                    >
                      <Star size={11} fill="currentColor" />
                      <span>
                        {card.catalogItem.avgRating !== null && card.catalogItem.avgRating !== undefined
                          ? `${card.catalogItem.avgRating.toFixed(1)} (${card.catalogItem.ratingCount ?? 0})`
                          : '暂无评分'}
                      </span>
                      {(card.catalogItem.myRatingChances ?? 0) > 0 && (
                        <span className={styles.rateReadyTag}>可评分</span>
                      )}
                    </button>

                    <span className={styles.playMetaPill}>
                      <Users size={11} /> {card.catalogItem.uniquePlayers ?? 0}人 · {card.catalogItem.playCount ?? 0}局
                    </span>

                    {(() => {
                      const liveHere = hubPresence.filter((p) => p.appId === card.appId);
                      const liveCount = liveHere.length || card.catalogItem?.activePlayerCount || 0;
                      if (liveCount <= 0) return null;
                      const label =
                        liveHere.length === 1
                          ? `${liveHere[0]!.displayName} 在玩`
                          : liveHere.length > 1
                            ? `${liveHere[0]!.displayName} 等 ${liveHere.length} 人在玩`
                            : `${liveCount} 人在玩`;
                      return (
                        <span className={styles.liveChip} title={liveHere.map((p) => p.displayName).join('、')}>
                          <span className={styles.liveDot} />
                          {label}
                        </span>
                      );
                    })()}

                    <button
                      type="button"
                      className={styles.statsLinkBtn}
                      onClick={() =>
                        setEngagementTarget({
                          appId: card.appId,
                          name: card.name,
                          initialTab: 'players',
                        })
                      }
                    >
                      <BarChart3 size={11} /> 数据趋势
                    </button>
                  </div>
                )}

                {canOpen && <div className={styles.cardActions}>
                  <Button
                    variant="filled"
                    size="small"
                    icon={<Play size={13} />}
                    loading={launchingId === card.appId}
                    onClick={() => void handleLaunchCard(card)}
                  >
                    {running ? '聚焦运行' : '打开'}
                  </Button>

                  {card.supportedModes.includes('sidepanel') && (
                    <Button
                      variant="glass"
                      size="small"
                      icon={<PanelRight size={13} />}
                      disabled={launchingId === card.appId}
                      onClick={() => void handleLaunchCard(card, 'sidepanel')}
                    >
                      右侧栏
                    </Button>
                  )}

                  {card.supportedModes.includes('standalone') && (
                    <Button
                      variant="glass"
                      size="small"
                      icon={<ExternalLink size={13} />}
                      disabled={launchingId === card.appId}
                      onClick={() => void handleLaunchCard(card, 'standalone')}
                    >
                      独立窗
                    </Button>
                  )}
                </div>}

                {canManageWork && (
                  <div className={styles.reviewBar}>
                    {launchVersion && (
                      <Button
                        variant="glass"
                        size="small"
                        icon={<Cloud size={13} />}
                        onClick={() =>
                          setFnDialogTarget({
                            appId: card.appId,
                            appName: card.name,
                            versionId: launchVersion.id,
                            versionLabel: launchVersion.version,
                            initialTab: hasCloudFunctions ? 'source' : 'secrets',
                          })
                        }
                      >
                        云函数管理
                      </Button>
                    )}
                    {pendingVersion && (
                      <Button
                        variant="glass"
                        size="small"
                        onClick={() => openWorkshopAction({
                          type: 'withdraw',
                          appId: card.appId,
                          name: card.name,
                          versionId: pendingVersion.id,
                          version: pendingVersion.version,
                        })}
                      >
                        撤回送审
                      </Button>
                    )}
                    {isPublished && (
                      <Button
                        variant="glass"
                        size="small"
                        destructive
                        onClick={() => openWorkshopAction({ type: 'suspend', appId: card.appId, name: card.name })}
                      >
                        下架作品
                      </Button>
                    )}
                    {recoveryVersion && (
                      <Button
                        variant="filled"
                        size="small"
                        onClick={() => openWorkshopAction({
                          type: 'resubmit',
                          appId: card.appId,
                          name: card.name,
                          versionId: recoveryVersion.id,
                          version: recoveryVersion.version,
                        })}
                      >
                        重新送审
                      </Button>
                    )}
                    {canUploadNewVersion && (
                      <Button variant="glass" size="small"
                        onClick={() => openUploadDialog({ appId: card.appId, name: card.name })}
                      >
                        上传新版本
                      </Button>
                    )}
                    {card.catalogItem?.canDeleteGame && (
                      <Button
                        variant="glass"
                        size="small"
                        destructive
                        onClick={() => openWorkshopAction({ type: 'delete', appId: card.appId, name: card.name })}
                      >
                        删除游戏
                      </Button>
                    )}
                  </div>
                )}

                {isReviewTab && pendingVersion && (
                  <div className={styles.reviewBar}>
                    {hasCloudFunctions && (
                      <Button
                        variant="glass"
                        size="small"
                        icon={<Cloud size={13} />}
                        onClick={() =>
                          setFnDialogTarget({
                            appId: card.appId,
                            appName: card.name,
                            versionId: pendingVersion.id,
                            versionLabel: pendingVersion.version,
                            initialTab: 'source',
                          })
                        }
                      >
                        审云函数源码
                      </Button>
                    )}
                    <Button
                      variant="filled"
                      size="small"
                      icon={<CheckCircle2 size={13} />}
                      onClick={() => void handleReview(card, 'approve')}
                    >
                      批准上架
                    </Button>
                    <Button
                      variant="glass"
                      size="small"
                      destructive
                      icon={<XCircle size={13} />}
                      onClick={() => void handleReview(card, 'reject')}
                    >
                      驳回
                    </Button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
          )}
        </div>

        {/* 右栏：常驻「此刻谁在玩」实时动态 + 「工坊排行榜」 */}
        <div className={styles.hubRightCol}>
          <section className={styles.hubPresencePanel} aria-label="此刻谁在玩">
            <div className={styles.lbPanelHead}>
              <div className={styles.lbPanelTitle}>
                <Radio size={14} className={styles.presenceTitleIcon} />
                <span>此刻谁在玩</span>
              </div>
              <span className={`${styles.presenceCountPill} ${hubPresence.length > 0 ? styles.presenceCountActive : ''}`}>
                {hubPresence.length} 人在玩
              </span>
            </div>

            {hubPresence.length === 0 ? (
              <div className={styles.presenceEmpty}>
                当前暂无同学在玩 · 打开任意作品后会在这里实时显示「谁正在玩什么」
              </div>
            ) : (
              <ul className={styles.presenceCardList}>
                {hubPresence.map((p) => {
                  const targetCard = unifiedCards.find((c) => c.appId === p.appId);
                  return (
                    <li key={`${p.userId}:${p.appId}`} className={styles.presenceCardRow}>
                      <span className={styles.presenceAvatarMd} aria-hidden="true">
                        {p.avatar ? (
                          <img src={p.avatar} alt="" className={styles.presenceAvatarImg} />
                        ) : (
                          Array.from(p.displayName)[0]?.toLocaleUpperCase() || '?'
                        )}
                        <span className={styles.presenceOnlineDot} />
                      </span>
                      <div className={styles.presenceRowMeta}>
                        <div className={styles.presenceRowTop}>
                          <MemberMention
                            handle={p.username || undefined}
                            name={p.displayName}
                            avatar={p.avatar || undefined}
                            size="small"
                            onSelectMember={setProfileSeed}
                          />
                          <span className={styles.presenceVerb}>正在玩</span>
                          <strong className={styles.presenceAppLink}>《{p.appName}》</strong>
                        </div>
                        <span className={styles.presenceTime}>{formatPlayingAgo(p.startedAt)}</span>
                      </div>
                      {targetCard && (
                        <button
                          type="button"
                          className={styles.presenceJoinBtn}
                          onClick={() => void handleLaunchCard(targetCard)}
                        >
                          一起玩
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <aside className={styles.hubLeaderboardAside} aria-label="工坊排行榜">
          <div className={styles.lbPanelHead}>
            <div className={styles.lbPanelTitle}>
              <Trophy size={15} />
              <span>工坊排行榜</span>
            </div>
            <div className={styles.lbMiniTabs}>
              {(
                [
                  { id: 'all', label: '全部' },
                  { id: 'minigame', label: '游戏' },
                  { id: 'miniapp', label: '应用' },
                ] as Array<{ id: LeaderboardTypeFilter; label: string }>
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`${styles.lbMiniChip} ${
                    leaderboardType === opt.id ? styles.lbMiniChipActive : ''
                  }`}
                  onClick={() => setLeaderboardType(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.lbSortRow}>
            {(
              [
                { id: 'composite', label: '综合推荐' },
                { id: 'rating', label: '最高评分' },
                { id: 'plays', label: '最多人玩' },
              ] as Array<{ id: LeaderboardSort; label: string }>
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`${styles.lbSortBtn} ${
                  leaderboardSort === opt.id ? styles.lbSortBtnActive : ''
                }`}
                onClick={() => setLeaderboardSort(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {leaderboardLoading && leaderboardItems.length === 0 ? (
            <div className={styles.lbEmpty}>正在加载排行榜…</div>
          ) : leaderboardItems.length === 0 ? (
            <div className={styles.lbEmpty}>暂无上榜作品，游玩并评分后自动展示</div>
          ) : (
            <ol className={styles.lbCompactList}>
              {leaderboardItems.map((item) => {
                const targetCard = unifiedCards.find((c) => c.appId === item.appId);
                const medalClass =
                  item.rank === 1
                    ? styles.rankGold
                    : item.rank === 2
                      ? styles.rankSilver
                      : item.rank === 3
                        ? styles.rankBronze
                        : '';
                return (
                  <li key={item.appId} className={styles.lbCompactRow}>
                    <button
                      type="button"
                      className={styles.lbRowMainBtn}
                      onClick={() =>
                        setEngagementTarget({
                          appId: item.appId,
                          name: item.name,
                          initialTab: 'players',
                        })
                      }
                      title="点击查看游玩趋势、热力图与谁玩过"
                    >
                      <span className={`${styles.rankNum} ${medalClass}`}>{item.rank}</span>
                      <div className={styles.lbIconSm}>
                        {item.iconUrl ? (
                          <img src={item.iconUrl} alt="" className={styles.cardIconImg} />
                        ) : item.type === 'minigame' ? (
                          <Gamepad2 size={14} />
                        ) : (
                          <Layers size={14} />
                        )}
                      </div>
                      <div className={styles.lbCompactInfo}>
                        <div className={styles.lbCompactTitleRow}>
                          <strong className={styles.lbCompactName}>{item.name}</strong>
                          {item.activePlayerCount > 0 && (
                            <span className={styles.liveChip}>
                              <span className={styles.liveDot} />
                              {item.activePlayerCount}
                            </span>
                          )}
                          {item.myRatingChances > 0 && (
                            <span className={styles.rateReadyTag}>可评</span>
                          )}
                        </div>
                        <div className={styles.lbCompactMeta}>
                          <span className={styles.lbRatingInline}>
                            <Star size={10} fill="currentColor" />
                            {item.avgRating !== null ? item.avgRating.toFixed(1) : '暂无'}
                            {item.ratingCount > 0 ? ` (${item.ratingCount})` : ''}
                          </span>
                          <span>
                            {item.uniquePlayers}人 · {item.totalPlays}局
                          </span>
                        </div>
                      </div>
                    </button>
                    {targetCard && (
                      <button
                        type="button"
                        className={styles.lbQuickPlayBtn}
                        disabled={launchingId === item.appId}
                        title={`打开《${item.name}》`}
                        onClick={() => void handleLaunchCard(targetCard)}
                      >
                        <Play size={12} fill="currentColor" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </aside>
        </div>
      </div>

      <Dialog
        open={workshopAction !== null}
        onOpenChange={(open) => { if (!open && !workshopActionSubmitting) setWorkshopAction(null); }}
        size="small"
        title={workshopAction ? workshopActionLabels[workshopAction.type].title : ''}
        description={workshopAction ? describeWorkshopAction(workshopAction) : undefined}
        dismissible={!workshopActionSubmitting}
        footer={
          <div className={styles.dialogFooter}>
            <Button variant="glass" size="small" disabled={workshopActionSubmitting} onClick={() => setWorkshopAction(null)}>
              取消
            </Button>
            <Button variant="filled" size="small" destructive={workshopAction?.type !== 'resubmit'} loading={workshopActionSubmitting} onClick={() => void submitWorkshopAction()}>
              {workshopAction ? workshopActionLabels[workshopAction.type].confirm : '确认'}
            </Button>
          </div>
        }
      >
        {workshopActionError && <Message tone="error">{workshopActionError}</Message>}
      </Dialog>

      {/* 本地调试台 Dialog */}
      <Dialog
        open={devOpen}
        onOpenChange={setDevOpen}
        size="regular"
        title="工坊本地调试台"
        description="支持直接加载 Cocos / Unity / Godot Web 构建目录，或连接本地前端 Vite Dev Server 热重载调试。"
      >
        <div className={styles.dialogBody}>
          <SegmentedControl
            value={devTab}
            onValueChange={(v) => setDevTab(v as 'dir' | 'url')}
            items={[
              { value: 'dir', label: '本地构建目录（推荐引擎）' },
              { value: 'url', label: 'Localhost 热重载' },
            ]}
          />

          {devTab === 'dir' ? (
            <div className={styles.formStack}>
              <div className={styles.pickerRow}>
                <Button
                  variant="glass"
                  size="small"
                  icon={<FolderOpen size={14} />}
                  onClick={() => void handlePickLocalDir()}
                >
                  选择应用目录
                </Button>
                <span className={styles.pickerHint}>
                  {pickedDirPath || '需包含 orbit.manifest.json 与入口 HTML'}
                </span>
              </div>

              {pickedDirManifest && (
                <div className={styles.previewBox}>
                  <strong>
                    {pickedDirManifest.name}（{pickedDirManifest.id} · v{pickedDirManifest.version}）
                  </strong>
                  <span>
                    引擎：{engineDisplayLabel(pickedDirManifest.engine)} · COOP/COEP：
                    {pickedDirManifest.runtime.crossOriginIsolated ? '已开启' : '关闭'}
                  </span>
                </div>
              )}

              <div className={styles.modeSelectRow}>
                <span className={styles.fieldLabel}>启动形态</span>
                <SegmentedControl
                  value={devDirMode}
                  onValueChange={(v) => setDevDirMode(v as MiniAppDisplayMode)}
                  items={[
                    { value: 'sidepanel', label: '右侧伴随栏' },
                    { value: 'workspace', label: '主区全幅' },
                    { value: 'standalone', label: '独立窗口' },
                  ]}
                />
              </div>

              <div className={styles.dialogFooter}>
                <Button variant="glass" size="small" onClick={() => setDevOpen(false)}>
                  取消
                </Button>
                <Button
                  variant="filled"
                  size="small"
                  disabled={!pickedDirManifest}
                  onClick={() => void handleLaunchLocalDir()}
                >
                  在容器中运行
                </Button>
              </div>
            </div>
          ) : (
            <form className={styles.formStack} onSubmit={handleLaunchDevUrl}>
              <Input
                variant="fill"
                placeholder="本地开发地址，例如 http://localhost:5173"
                value={devUrl}
                onValueChange={setDevUrl}
              />
              <div className={styles.twoCol}>
                <Input
                  variant="fill"
                  placeholder="应用 ID（小写短横线）"
                  value={devUrlAppId}
                  onValueChange={setDevUrlAppId}
                />
                <Input
                  variant="fill"
                  placeholder="显示名称"
                  value={devUrlName}
                  onValueChange={setDevUrlName}
                />
              </div>
              <div className={styles.modeSelectRow}>
                <span className={styles.fieldLabel}>启动形态</span>
                <SegmentedControl
                  value={devUrlMode}
                  onValueChange={(v) => setDevUrlMode(v as MiniAppDisplayMode)}
                  items={[
                    { value: 'sidepanel', label: '右侧伴随栏' },
                    { value: 'workspace', label: '主区全幅' },
                    { value: 'standalone', label: '独立窗口' },
                  ]}
                />
              </div>
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={devUrlIso}
                  onChange={(e) => setDevUrlIso(e.target.checked)}
                />
                <span>注入 COOP/COEP 响应头（开启 SharedArrayBuffer 支持）</span>
              </label>

              <div className={styles.dialogFooter}>
                <Button variant="glass" size="small" onClick={() => setDevOpen(false)}>
                  取消
                </Button>
                <Button variant="filled" size="small" type="submit">
                  连接并运行
                </Button>
              </div>
            </form>
          )}
        </div>
      </Dialog>

      {/* 上传 / GitHub 导入 Dialog */}
      <Dialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        size="regular"
        title={uploadTarget ? `上传《${uploadTarget.name}》的新版本` : '发布作品到 Orbit 工坊'}
        description={uploadTarget
          ? `请保留清单里的作品 ID「${uploadTarget.appId}」，建议提高 version 后重新打包。新版本由队长审核，历史版本和存档保留。`
          : '≤ 100 MB 构建包支持直传校园 RustFS；超过 100 MB 的重型小游戏可通过 GitHub Releases 链接零校园带宽导入。'}
      >
        <form className={styles.dialogBody} onSubmit={handleSubmitUpload}>
          <SegmentedControl
            value={uploadSource}
            onValueChange={(v) => setUploadSource(v as 'zip' | 'github')}
            items={[
              { value: 'zip', label: '上传 ZIP / .lecapp（≤ 100MB）' },
              { value: 'github', label: 'GitHub Releases 导入（大包）' },
            ]}
          />

          {uploadSource === 'zip' ? (
            <div className={styles.formStack}>
              <div className={styles.pickerRow}>
                <Button
                  variant="glass"
                  size="small"
                  icon={<Upload size={14} />}
                  onClick={() => void handlePickZip()}
                >
                  选择构建包
                </Button>
                <span className={styles.pickerHint}>
                  {zipInfo
                    ? `${zipInfo.fileName} (${formatBytesCompact(zipInfo.sizeBytes)})`
                    : '压缩包内需包含 orbit.manifest.json 与入口 HTML'}
                </span>
              </div>

              {zipInfo && (
                <div className={styles.previewBox}>
                  <strong>
                    {zipInfo.manifest.name}（{zipInfo.manifest.id} · v{zipInfo.manifest.version}）
                  </strong>
                  <span>
                    类型：{zipInfo.manifest.type === 'minigame' ? '小游戏' : '小程序'} · 引擎：
                    {engineDisplayLabel(zipInfo.manifest.engine)} · 默认形态：
                    {modeDisplayLabel(zipInfo.manifest.window.defaultMode)}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className={styles.formStack}>
              <Input
                variant="fill"
                icon={<GitBranch size={14} />}
                placeholder="GitHub Releases ZIP 资产直链（https://github.com/.../releases/download/...）"
                value={ghUrl}
                onValueChange={setGhUrl}
              />
              <Input
                variant="fill"
                placeholder="64 位 SHA256 校验值（防篡改与本地缓存比对）"
                value={ghSha256}
                onValueChange={setGhSha256}
              />
              <textarea
                className={styles.textarea}
                rows={5}
                placeholder="粘贴该版本对应的 orbit.manifest.json 内容"
                value={ghManifestText}
                onChange={(e) => setGhManifestText(e.target.value)}
              />
            </div>
          )}

          {!uploadTarget && <div className={styles.modeSelectRow}>
            <span className={styles.fieldLabel}>发布通道</span>
            <SegmentedControl
              value={uploadChannel}
              onValueChange={(v) => setUploadChannel(v as 'release' | 'preview')}
              items={[
                { value: 'release', label: '提交正式上架' },
                { value: 'preview', label: '仅体验版（作者可见）' },
              ]}
            />
          </div>}

          <Input
            variant="fill"
            placeholder="更新日志（选填，例如：新增双人对战模式）"
            value={uploadChangelog}
            onValueChange={setUploadChangelog}
          />

          {!uploadTarget && auth.isAdmin && uploadChannel === 'release' && (
            <label className={styles.checkboxRow}>
              <input
                type="checkbox"
                checked={directPublish}
                onChange={(e) => setDirectPublish(e.target.checked)}
              />
              <span>队长免审直接上架</span>
            </label>
          )}

          {uploadErr && <Message tone="error">{uploadErr}</Message>}

          <div className={styles.dialogFooter}>
            <Button variant="glass" size="small" onClick={() => setUploadOpen(false)}>
              取消
            </Button>
            <Button variant="filled" size="small" type="submit" loading={uploadSubmitting}>
              {uploadTarget ? '提交审核' : uploadSource === 'zip' ? '校验并上传' : '登记导入'}
            </Button>
          </div>
        </form>
      </Dialog>
      <MiniAppFunctionsDialog
        target={fnDialogTarget}
        onClose={() => setFnDialogTarget(null)}
      />
      <MiniAppEngagementDialog
        target={engagementTarget}
        onClose={() => setEngagementTarget(null)}
        onRated={() => {
          void refreshHubData();
          void loadLeaderboard(leaderboardSort, leaderboardType);
        }}
      />
      <MemberProfileDialog seed={profileSeed} onClose={() => setProfileSeed(null)} />
    </div>
  );
}
