/**
 * 独立窗口模式下的 38px 液态玻璃顶栏壳（hash 路由 #miniapp-window/<appId>）：
 * - 下方区域由 Electron 主进程直接挂载同一 WebContentsView
 * - 支持一键无损「贴回软件右侧栏」「主区展开」「刷新」「DevTools」「全屏」
 */
import { useEffect, useState, type JSX } from 'react';
import {
  Bug,
  Maximize,
  PanelRight,
  RefreshCw,
  ShieldCheck,
  Square,
} from 'lucide-react';
import { engineDisplayLabel, type RunningMiniAppState } from '@shared/miniapp';
import { getOrbitClient } from '@/services/orbitClient';
import styles from './MiniAppStandaloneShell.module.css';

interface Props {
  appId: string;
}

export function MiniAppStandaloneShell({ appId }: Props): JSX.Element {
  const [appState, setAppState] = useState<RunningMiniAppState | null>(null);
  const isMac = getOrbitClient().platform === 'darwin';

  useEffect(() => {
    const orbit = getOrbitClient();
    const syncFromSnapshot = (apps: RunningMiniAppState[]) => {
      setAppState(apps.find((a) => a.appId === appId) ?? null);
    };
    void orbit.hub.getRuntimeSnapshot().then((snap) => syncFromSnapshot(snap.apps));
    return orbit.hub.onRuntimeChanged((snap) => syncFromSnapshot(snap.apps));
  }, [appId]);

  const canSidepanel = appState?.supportedModes.includes('sidepanel') ?? true;
  const canWorkspace = appState?.supportedModes.includes('workspace') ?? true;

  return (
    <div className={styles.root}>
      <header className={`${styles.header} ${isMac ? styles.headerMac : styles.headerWin}`}>
        <div className={`${styles.left} orbit-drag`}>
          <span className={styles.title}>{appState?.name ?? appId}</span>
          {appState && (
            <>
              <span className={styles.badge}>{engineDisplayLabel(appState.engine)}</span>
              <span className={styles.version}>v{appState.version}</span>
              {appState.crossOriginIsolated && (
                <span
                  className={styles.isoBadge}
                  title="COOP/COEP 跨源隔离已开启（SharedArrayBuffer 可用）"
                >
                  <ShieldCheck size={11} />
                  SAB
                </span>
              )}
            </>
          )}
        </div>

        <div className={`${styles.dragSpacer} orbit-drag`} />

        <div className={`${styles.actions} orbit-no-drag`}>
          {canSidepanel && (
            <button
              type="button"
              className={`${styles.pillBtn} orbit-no-drag`}
              title="贴回 Orbit 主窗右侧伴随栏（不刷新、保留进度）"
              onClick={() => void getOrbitClient().hub.switchMode(appId, 'sidepanel')}
            >
              <PanelRight size={13} />
              <span>贴回右侧</span>
            </button>
          )}
          {canWorkspace && (
            <button
              type="button"
              className={`${styles.iconBtn} orbit-no-drag`}
              title="切换至主窗全幅内嵌（不刷新）"
              onClick={() => void getOrbitClient().hub.switchMode(appId, 'workspace')}
            >
              <Square size={13} />
            </button>
          )}
          <button
            type="button"
            className={`${styles.iconBtn} orbit-no-drag`}
            title="刷新"
            onClick={() => void getOrbitClient().hub.reload(appId)}
          >
            <RefreshCw size={13} />
          </button>
          <button
            type="button"
            className={`${styles.iconBtn} orbit-no-drag`}
            title="打开 DevTools"
            onClick={() => void getOrbitClient().hub.openDevTools(appId)}
          >
            <Bug size={13} />
          </button>
          <button
            type="button"
            className={`${styles.iconBtn} orbit-no-drag`}
            title="切换全屏"
            onClick={() => void getOrbitClient().hub.toggleFullscreen(appId)}
          >
            <Maximize size={13} />
          </button>
        </div>
      </header>
    </div>
  );
}
