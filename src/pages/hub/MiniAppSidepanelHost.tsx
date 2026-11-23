/**
 * Orbit 主窗口右侧伴随栏宿主（sidepanel）：
 * - 贴合在软件最右侧占一小块区域（默认 400px，支持左边缘拖拽 320~640px 自由缩放）
 * - 不打断主窗口当前页面（可一边看打卡/周报/LecDoc，一边在右侧运行小程序）
 * - 支持一键无损切换至「主区全幅」或「独立窗口」（底层复用同一 WebContentsView，零刷新）
 */
import { useEffect, useLayoutEffect, useRef, useState, type JSX, type MouseEvent as ReactMouseEvent } from 'react';
import {
  Bug,
  ExternalLink,
  Maximize2,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import { engineDisplayLabel, type RunningMiniAppState } from '@shared/miniapp';
import { getOrbitClient, isDesktopRuntime } from '@/services/orbitClient';
import { useOrbitStore } from '@/stores/useOrbitStore';
import styles from './MiniAppSidepanelHost.module.css';

interface Props {
  app: RunningMiniAppState;
}

export function MiniAppSidepanelHost({ app }: Props): JSX.Element {
  const setActiveTab = useOrbitStore((s) => s.setActiveTab);
  const [width, setWidth] = useState<number>(() =>
    Math.min(640, Math.max(320, app.sidepanelWidth || 400)),
  );
  const [dragging, setDragging] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    setWidth(Math.min(640, Math.max(320, app.sidepanelWidth || 400)));
  }, [app.appId, app.sidepanelWidth]);

  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--orbit-sidepanel-offset', `${width}px`);
    return () => {
      document.documentElement.style.removeProperty('--orbit-sidepanel-offset');
    };
  }, [width]);

  useEffect(() => {
    const orbit = getOrbitClient();
    const syncBounds = (persistWidth?: number) => {
      const el = viewportRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      void orbit.hub.setSidepanelBounds(
        {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.max(0, Math.round(rect.width)),
          height: Math.max(0, Math.round(rect.height)),
        },
        persistWidth,
      );
    };

    syncBounds();
    const observer = new ResizeObserver(() => syncBounds());
    if (viewportRef.current) observer.observe(viewportRef.current);
    const onResize = () => syncBounds();
    window.addEventListener('resize', onResize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      void orbit.hub.setSidepanelBounds({ x: 0, y: 0, width: 0, height: 0 });
    };
  }, [app.appId]);

  const handleResizeStart = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    setDragging(true);

    const onMove = (ev: MouseEvent) => {
      const next = Math.min(640, Math.max(320, startW + (startX - ev.clientX)));
      setWidth(next);
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const el = viewportRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        void getOrbitClient().hub.setSidepanelBounds(
          {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.max(0, Math.round(rect.width)),
            height: Math.max(0, Math.round(rect.height)),
          },
          Math.round(widthRef.current),
        );
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const canWorkspace = app.supportedModes.includes('workspace');
  const canStandalone = app.supportedModes.includes('standalone');

  return (
    <aside
      className={`${styles.panel} ${dragging ? styles.panelDragging : ''}`}
      style={{ width }}
      aria-label={`右侧伴随栏：${app.name}`}
    >
      <div
        className={styles.resizeHandle}
        onMouseDown={handleResizeStart}
        title="拖拽调整右侧栏宽度"
      />

      <header className={styles.header}>
        <div className={styles.titleGroup}>
          <span className={styles.title} title={app.name}>
            {app.name}
          </span>
          <span className={styles.metaChip}>{engineDisplayLabel(app.engine)}</span>
          {app.crossOriginIsolated && (
            <span className={styles.isoChip} title="已启用 COOP/COEP 跨源隔离（SharedArrayBuffer 可用）">
              <ShieldCheck size={11} />
            </span>
          )}
        </div>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.iconBtn}
            title="刷新应用"
            onClick={() => void getOrbitClient().hub.reload(app.appId)}
          >
            <RefreshCw size={13} />
          </button>
          {canWorkspace && (
            <button
              type="button"
              className={styles.iconBtn}
              title="在主区全幅展开（不刷新）"
              onClick={() => {
                setActiveTab('hub');
                void getOrbitClient().hub.switchMode(app.appId, 'workspace');
              }}
            >
              <Maximize2 size={13} />
            </button>
          )}
          {canStandalone && (
            <button
              type="button"
              className={styles.iconBtn}
              title="弹出为独立窗口（不刷新）"
              onClick={() => void getOrbitClient().hub.switchMode(app.appId, 'standalone')}
            >
              <ExternalLink size={13} />
            </button>
          )}
          <button
            type="button"
            className={styles.iconBtn}
            title="打开开发者调试台 (DevTools)"
            onClick={() => void getOrbitClient().hub.openDevTools(app.appId)}
          >
            <Bug size={13} />
          </button>
          <button
            type="button"
            className={`${styles.iconBtn} ${styles.closeBtn}`}
            title="关闭右侧应用"
            onClick={() => void getOrbitClient().hub.close(app.appId)}
          >
            <X size={14} />
          </button>
        </div>
      </header>

      <div ref={viewportRef} className={styles.viewport}>
        {(!isDesktopRuntime() || app.overlayHidden || app.error) && (
          <div className={styles.placeholder}>
            <p className={styles.placeholderTitle}>
              {app.error
                ? app.error
                : app.overlayHidden
                  ? '右侧小程序已临时避让当前弹窗'
                  : '工坊容器仅在 Electron 桌面运行时渲染'}
            </p>
            <p className={styles.placeholderSub}>
              {app.overlayHidden ? '关闭弹窗后自动恢复原界面与状态' : `${app.name} · v${app.version}`}
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}
