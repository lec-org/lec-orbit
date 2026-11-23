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
  Bug,
  CheckCircle2,
  Code2,
  ExternalLink,
  FolderOpen,
  Gamepad2,
  GitBranch,
  HardDrive,
  Layers,
  PanelRight,
  Play,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
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
import { getOrbitClient, isDesktopRuntime } from '@/services/orbitClient';
import { orbitServerApi } from '@/services/orbitServerApi';
import { notifyToast } from '@/services/orbitToast';
import { useOrbitStore } from '@/stores/useOrbitStore';
import styles from './Hub.module.css';

type HubFilterTab = 'all' | 'miniapp' | 'minigame' | 'mine' | 'pending';
type EngineFilter = 'all' | MiniAppEngine;

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
  const hubLoading = useOrbitStore((s) => s.hubLoading);
  const hubError = useOrbitStore((s) => s.hubError);
  const refreshHubData = useOrbitStore((s) => s.refreshHubData);
  const refreshHubLocal = useOrbitStore((s) => s.refreshHubLocal);
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
  const [uploadSource, setUploadSource] = useState<'zip' | 'github'>('zip');
  const [zipInfo, setZipInfo] = useState<{
    filePath: string;
    fileName: string;
    sizeBytes: number;
    manifest: OrbitAppManifest;
  } | null>(null);
  const [uploadChannel, setUploadChannel] = useState<'release' | 'preview'>('release');
  const [uploadChangelog, setUploadChangelog] = useState('');
  const [directPublish, setDirectPublish] = useState(false);
  const [uploadSubmitting, setUploadSubmitting] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);

  // GitHub 导入字段
  const [ghUrl, setGhUrl] = useState('');
  const [ghSha256, setGhSha256] = useState('');
  const [ghManifestText, setGhManifestText] = useState('');

  useEffect(() => {
    void refreshHubData();
  }, [refreshHubData]);

  useEffect(() => {
    if (!devOpen && !uploadOpen) return;
    pushOverlay();
    return () => popOverlay();
  }, [devOpen, uploadOpen, pushOverlay, popOverlay]);

  const workspaceApp = useMemo(
    () => hubRuntime.apps.find((a) => a.mode === 'workspace') ?? null,
    [hubRuntime.apps],
  );

  const pendingCount = useMemo(
    () => hubCatalog.filter((c) => c.latestVersion?.status === 'pending').length,
    [hubCatalog],
  );

  const unifiedCards = useMemo<UnifiedHubCard[]>(() => {
    const installedMap = new Map(hubInstalled.map((item) => [item.appId, item]));
    const cards: UnifiedHubCard[] = [];
    const seen = new Set<string>();

    // 1. 线上工坊目录
    for (const item of hubCatalog) {
      const targetVer = item.activeVersion ?? item.latestVersion;
      if (!targetVer) continue;
      seen.add(item.id);
      const inst = installedMap.get(item.id);
      cards.push({
        appId: item.id,
        name: item.name,
        type: item.type,
        engine: item.engine,
        version: targetVer.version,
        description: item.description,
        tags: item.tags,
        defaultMode: targetVer.manifest.window.defaultMode,
        supportedModes: targetVer.manifest.window.supportedModes,
        crossOriginIsolated: targetVer.manifest.runtime.crossOriginIsolated,
        isBuiltin: false,
        isInstalled: Boolean(inst && inst.version === targetVer.version),
        installedSizeBytes: inst?.sizeBytes ?? targetVer.bundleSize,
        iconUrl: item.iconUrl,
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
  }, [hubBuiltins, hubCatalog, hubInstalled]);

  const filteredCards = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return unifiedCards.filter((card) => {
      if (tab === 'miniapp' && card.type !== 'miniapp') return false;
      if (tab === 'minigame' && card.type !== 'minigame') return false;
      if (tab === 'mine') {
        if (!card.catalogItem || card.catalogItem.ownerId !== auth.profile?.subject) return false;
      }
      if (tab === 'pending') {
        if (card.catalogItem?.latestVersion?.status !== 'pending') return false;
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
      const targetVer =
        tab === 'pending' || tab === 'mine'
          ? card.catalogItem?.latestVersion ?? card.catalogItem?.activeVersion
          : card.catalogItem?.activeVersion ?? card.catalogItem?.latestVersion;

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
      if (!card.isBuiltin) {
        void orbitServerApi.recordMiniAppPlay(card.appId);
      }
      await refreshHubLocal();
      notifyToast({
        tone: 'success',
        title: `已启动「${launched.name}」`,
        description: `当前形态：${modeDisplayLabel(launched.mode)}（可随时一键无损切换）`,
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

  const handlePickZip = async () => {
    setUploadErr(null);
    const res = await getOrbitClient().hub.pickZipFile();
    if (res.cancelled) return;
    if (!res.ok || !res.filePath || !res.fileName || !res.manifest || res.sizeBytes == null) {
      setUploadErr(res.error || '构建包校验失败');
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
          channel: uploadChannel,
          changelog: uploadChangelog.trim(),
          directPublish: auth.isAdmin && directPublish,
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
        await orbitServerApi.importGitHubMiniApp({
          bundleUrl: ghUrl.trim(),
          bundleSha256: ghSha256.trim(),
          channel: uploadChannel,
          changelog: uploadChangelog.trim(),
          directPublish: auth.isAdmin && directPublish,
          manifest,
        });
      }

      setUploadOpen(false);
      setZipInfo(null);
      setUploadChangelog('');
      await refreshHubData();
      notifyToast({
        tone: 'success',
        title: auth.isAdmin && directPublish ? '作品已直接发布上架' : '作品上传成功',
        description:
          auth.isAdmin && directPublish
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
    const ver = card.catalogItem?.latestVersion;
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
      notifyToast({
        tone: 'error',
        title: '审核操作失败',
        description: err instanceof Error ? err.message : '未知错误',
      });
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
            onClick={() => {
              setUploadErr(null);
              setUploadOpen(true);
            }}
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

      {hubError && <Message tone="info">{hubError}</Message>}

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
            const isPending = card.catalogItem?.latestVersion?.status === 'pending';
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
                      {isPending && <Tag tone="warning">待审核</Tag>}
                    </div>
                  </div>
                </div>

                <p className={styles.cardDesc}>
                  {card.description || '工作室成员自研工坊作品，点击即可在隔离沙箱中体验。'}
                </p>

                <div className={styles.cardMeta}>
                  <span>{card.ownerName || '工作室成员'}</span>
                  <span>
                    默认：{modeDisplayLabel(card.defaultMode)}
                    {card.installedSizeBytes ? ` · ${formatBytesCompact(card.installedSizeBytes)}` : ''}
                  </span>
                </div>

                <div className={styles.cardActions}>
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
                </div>

                {auth.isAdmin && isPending && (
                  <div className={styles.reviewBar}>
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
        title="发布作品到 Orbit 工坊"
        description="≤ 100 MB 构建包支持直传校园 RustFS；超过 100 MB 的重型小游戏可通过 GitHub Releases 链接零校园带宽导入。"
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

          <div className={styles.modeSelectRow}>
            <span className={styles.fieldLabel}>发布通道</span>
            <SegmentedControl
              value={uploadChannel}
              onValueChange={(v) => setUploadChannel(v as 'release' | 'preview')}
              items={[
                { value: 'release', label: '提交正式上架' },
                { value: 'preview', label: '仅体验版（作者可见）' },
              ]}
            />
          </div>

          <Input
            variant="fill"
            placeholder="更新日志（选填，例如：新增双人对战模式）"
            value={uploadChangelog}
            onValueChange={setUploadChangelog}
          />

          {auth.isAdmin && uploadChannel === 'release' && (
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
              {uploadSource === 'zip' ? '校验并上传' : '登记导入'}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
