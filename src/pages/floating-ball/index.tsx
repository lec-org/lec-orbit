/**
 * Orbit 灵动打卡胶囊（Dynamic Island × Liquid Glass 风格）：
 * - 收起态：黑曜石液态玻璃灵动胶囊，左侧迷你进度环/呼吸灯、中间等宽实时计时、右侧防误触快捷按钮；
 * - 展开态：紧凑灵动卡片，实时专注大表盘、本周流体进度条、一键签到 / 二次确认防误触签退与主窗口直达；
 * - 自由摆放（不强制吸边）+ rAF 拖拽节流 + 拖后 350ms 静默防误触 + 1.5s 打卡冷却节流。
 */
import { useEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react';
import { Check, ExternalLink, Play, Square, X } from 'lucide-react';
import type { FloatingBallState } from '@shared/ipc';
import { formatClockDuration, formatReadableDuration } from '@shared/punch';
import { getOrbitClient } from '@/services/orbitClient';
import styles from './FloatingBall.module.css';

const DRAG_THRESHOLD_PX = 6;
const POST_DRAG_GUARD_MS = 350;
const EXPAND_THROTTLE_MS = 320;
const PUNCH_COOLDOWN_MS = 1500;
const SIGNOUT_CONFIRM_MS = 2800;

export function FloatingBallPage(): JSX.Element {
  const [state, setState] = useState<FloatingBallState>({
    checkedIn: false,
    elapsedSeconds: 0,
    todaySeconds: 0,
    weekSeconds: 0,
    weekTargetSeconds: 18 * 3600,
    networkAllowed: true,
    authenticated: false,
    statusLabel: '未打卡',
    expanded: false,
    theme: 'system',
  });
  const [tickDelta, setTickDelta] = useState(0);
  const [punchCooling, setPunchCooling] = useState(false);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

  const dragRef = useRef<{
    pointerId: number;
    startScreenX: number;
    startScreenY: number;
    winStartX: number;
    winStartY: number;
    moved: boolean;
  } | null>(null);
  const rafMoveRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<{ x: number; y: number } | null>(null);
  const lastDragEndAtRef = useRef(0);
  const lastExpandToggleAtRef = useRef(0);
  const lastPunchAtRef = useRef(0);
  const confirmTimerRef = useRef<number | null>(null);
  const coolTimerRef = useRef<number | null>(null);

  useEffect(() => {
    document.documentElement.classList.add('orbit-floating-transparent');
    document.body.classList.add('orbit-floating-transparent');
    const orbit = getOrbitClient();
    void orbit.floating.getState().then((s) => {
      setState(s);
      setTickDelta(0);
    });
    const off = orbit.floating.onStateChanged((next) => {
      setState(next);
      setTickDelta(0);
      if (!next.checkedIn) {
        setConfirmingSignOut(false);
      }
    });
    return () => {
      off();
      if (rafMoveRef.current !== null) cancelAnimationFrame(rafMoveRef.current);
      if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
      if (coolTimerRef.current !== null) window.clearTimeout(coolTimerRef.current);
      document.documentElement.classList.remove('orbit-floating-transparent');
      document.body.classList.remove('orbit-floating-transparent');
    };
  }, []);

  useEffect(() => {
    if (!state.checkedIn) return;
    const timer = setInterval(() => setTickDelta((d) => d + 1), 1000);
    return () => clearInterval(timer);
  }, [state.checkedIn]);

  const liveElapsed = state.checkedIn ? state.elapsedSeconds + tickDelta : state.elapsedSeconds;
  const liveWeek = (state.weekSeconds ?? 0) + (state.checkedIn ? tickDelta : 0);
  const target = state.weekTargetSeconds || 18 * 3600;
  const progress = Math.min(1, liveWeek / Math.max(1, target));
  const progressPct = Math.round(progress * 100);

  const isWithinPostDragGuard = () => Date.now() - lastDragEndAtRef.current < POST_DRAG_GUARD_MS;

  const safeToggleExpanded = (next: boolean) => {
    const now = Date.now();
    if (isWithinPostDragGuard()) return;
    if (now - lastExpandToggleAtRef.current < EXPAND_THROTTLE_MS) return;
    lastExpandToggleAtRef.current = now;
    setConfirmingSignOut(false);
    void getOrbitClient().floating.setExpanded(next);
  };

  /** 防误触打卡：1.5s 冷却节流 + 签退需 2.8s 内二次确认，防止误碰结束专注。 */
  const safeTriggerPunch = () => {
    const now = Date.now();
    if (isWithinPostDragGuard()) return;
    if (punchCooling || now - lastPunchAtRef.current < PUNCH_COOLDOWN_MS) return;

    // 已在专注计时中：首次点击进入二次确认态，避免手滑误点签退
    if (state.checkedIn && !confirmingSignOut) {
      setConfirmingSignOut(true);
      if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = window.setTimeout(() => {
        setConfirmingSignOut(false);
      }, SIGNOUT_CONFIRM_MS);
      return;
    }

    if (confirmTimerRef.current !== null) {
      window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    setConfirmingSignOut(false);
    lastPunchAtRef.current = now;
    setPunchCooling(true);
    if (coolTimerRef.current !== null) window.clearTimeout(coolTimerRef.current);
    coolTimerRef.current = window.setTimeout(() => {
      setPunchCooling(false);
    }, PUNCH_COOLDOWN_MS);
    void getOrbitClient().floating.togglePunch();
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    dragRef.current = {
      pointerId: e.pointerId,
      startScreenX: e.screenX,
      startScreenY: e.screenY,
      winStartX: window.screenX,
      winStartY: window.screenY,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.screenX - drag.startScreenX;
    const dy = e.screenY - drag.startScreenY;
    if (!drag.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
      drag.moved = true;
    }
    if (drag.moved) {
      pendingMoveRef.current = { x: drag.winStartX + dx, y: drag.winStartY + dy };
      if (rafMoveRef.current === null) {
        rafMoveRef.current = requestAnimationFrame(() => {
          rafMoveRef.current = null;
          const pos = pendingMoveRef.current;
          if (pos) {
            void getOrbitClient().floating.moveTo(pos.x, pos.y);
          }
        });
      }
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>, toggleOnClick: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const wasDrag = drag.moved;
    dragRef.current = null;
    pendingMoveRef.current = null;
    if (rafMoveRef.current !== null) {
      cancelAnimationFrame(rafMoveRef.current);
      rafMoveRef.current = null;
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (wasDrag) {
      lastDragEndAtRef.current = Date.now();
      void getOrbitClient().floating.snapToEdge();
    } else if (toggleOnClick) {
      safeToggleExpanded(!state.expanded);
    }
  };

  // 收起态：Dynamic Island 风格黑曜石液态玻璃灵动胶囊
  if (!state.expanded) {
    const r = 8.5;
    const circumference = 2 * Math.PI * r;
    const dashOffset = circumference * (1 - Math.max(0.06, progress));

    return (
      <div className={styles.root}>
        <div
          role="button"
          tabIndex={0}
          className={`${styles.pill} ${state.checkedIn ? styles.pillActive : ''}`}
          title={
            state.checkedIn
              ? `专注计时中 ${formatClockDuration(liveElapsed)} · 单击展开 / 拖拽任意摆放`
              : '单击展开打卡胶囊 · 拖拽任意摆放'
          }
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => onPointerUp(e, true)}
        >
          <span className={styles.ringBadge} aria-hidden="true">
            <svg className={styles.miniRingSvg} viewBox="0 0 22 22">
              <circle className={styles.miniRingTrack} cx="11" cy="11" r={r} />
              <circle
                className={`${styles.miniRingProg} ${state.checkedIn ? styles.miniRingProgOn : ''}`}
                cx="11"
                cy="11"
                r={r}
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
              />
            </svg>
            <span className={`${styles.coreDot} ${state.checkedIn ? styles.coreDotOn : ''}`} />
          </span>

          <span className={styles.pillText}>
            {confirmingSignOut
              ? '再点签退'
              : state.checkedIn
                ? formatClockDuration(liveElapsed)
                : state.authenticated
                  ? '开始专注'
                  : '未登录'}
          </span>

          <button
            type="button"
            disabled={punchCooling}
            className={`${styles.pillQuickBtn} ${
              confirmingSignOut
                ? styles.pillQuickConfirm
                : state.checkedIn
                  ? styles.pillQuickOut
                  : styles.pillQuickIn
            }`}
            title={
              confirmingSignOut
                ? '再次点击确认签退'
                : state.checkedIn
                  ? '点击进入签退确认（防误触）'
                  : '一键签到'
            }
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              safeTriggerPunch();
            }}
          >
            {confirmingSignOut ? (
              <Check size={11} />
            ) : state.checkedIn ? (
              <Square size={9} fill="currentColor" />
            ) : (
              <Play size={10} fill="currentColor" />
            )}
          </button>
        </div>
      </div>
    );
  }

  // 展开态：灵动岛展开控制卡
  return (
    <div className={styles.root}>
      <div
        className={`${styles.island} ${state.checkedIn ? styles.islandActive : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => onPointerUp(e, false)}
      >
        <div className={styles.islandTop}>
          <div className={styles.statusCluster}>
            <span className={`${styles.pulseDot} ${state.checkedIn ? styles.pulseDotOn : ''}`} />
            <span className={styles.statusText}>
              {state.checkedIn ? '专注计时中' : state.authenticated ? '准备就绪' : '请先登录'}
            </span>
            <span className={styles.pctBadge}>本周 {progressPct}%</span>
          </div>

          <div className={styles.topTools} onPointerDown={(e) => e.stopPropagation()}>
            <button
              type="button"
              className={styles.toolBtn}
              title="打开 Orbit 主窗口"
              onClick={() => {
                if (!isWithinPostDragGuard()) {
                  void getOrbitClient().floating.openMain();
                }
              }}
            >
              <ExternalLink size={12} />
            </button>
            <button
              type="button"
              className={styles.toolBtn}
              title="收起为灵动胶囊"
              onClick={() => safeToggleExpanded(false)}
            >
              <X size={12} />
            </button>
          </div>
        </div>

        <div className={styles.islandMiddle}>
          <div className={styles.clockBlock}>
            <div className={styles.clockDigits}>
              {state.checkedIn ? formatClockDuration(liveElapsed) : '00:00:00'}
            </div>
            <div className={styles.weekSub}>
              本周 {formatReadableDuration(liveWeek)} / {formatReadableDuration(target)}
            </div>
          </div>

          <button
            type="button"
            disabled={punchCooling}
            className={`${styles.actionBtn} ${
              confirmingSignOut
                ? styles.actionConfirm
                : state.checkedIn
                  ? styles.actionOut
                  : styles.actionIn
            }`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={safeTriggerPunch}
          >
            {confirmingSignOut ? (
              <Check size={12} />
            ) : state.checkedIn ? (
              <Square size={11} fill="currentColor" />
            ) : (
              <Play size={11} fill="currentColor" />
            )}
            <span>{confirmingSignOut ? '确认签退' : state.checkedIn ? '签退' : '签到'}</span>
          </button>
        </div>

        <div className={styles.progressTrack}>
          <div
            className={`${styles.progressFill} ${state.checkedIn ? styles.progressFillOn : ''}`}
            style={{ width: `${Math.max(4, progressPct)}%` }}
          />
        </div>
      </div>
    </div>
  );
}
