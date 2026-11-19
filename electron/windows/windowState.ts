/**
 * 多显示器窗口边界安全恢复（借鉴 VS Code WindowState 策略）：
 * 外接显示器拔除或缩放变化时，防止窗口坐标越界导致“窗口看不见”。
 */
import type { WindowBounds } from '../../src/shared/ipc';

export interface DisplayWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_MAIN_WIDTH = 1240;
export const DEFAULT_MAIN_HEIGHT = 820;
export const MIN_MAIN_WIDTH = 960;
export const MIN_MAIN_HEIGHT = 640;

function intersectionArea(a: DisplayWorkArea, b: DisplayWorkArea): number {
  const xOverlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const yOverlap = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return xOverlap * yOverlap;
}

export function resolveSafeWindowBounds(
  saved: WindowBounds | undefined,
  displays: readonly DisplayWorkArea[],
  primary: DisplayWorkArea,
): WindowBounds {
  const fallbackWidth = Math.min(DEFAULT_MAIN_WIDTH, Math.max(MIN_MAIN_WIDTH, primary.width - 80));
  const fallbackHeight = Math.min(DEFAULT_MAIN_HEIGHT, Math.max(MIN_MAIN_HEIGHT, primary.height - 80));
  const centeredFallback: WindowBounds = {
    x: Math.round(primary.x + (primary.width - fallbackWidth) / 2),
    y: Math.round(primary.y + (primary.height - fallbackHeight) / 2),
    width: fallbackWidth,
    height: fallbackHeight,
    isMaximized: false,
  };

  if (!saved) return centeredFallback;

  const width = Math.max(MIN_MAIN_WIDTH, Math.round(saved.width));
  const height = Math.max(MIN_MAIN_HEIGHT, Math.round(saved.height));
  const candidate: DisplayWorkArea = {
    x: Math.round(saved.x),
    y: Math.round(saved.y),
    width,
    height,
  };

  // 寻找与历史窗口相交面积最大的当前在线显示器
  let bestDisplay: DisplayWorkArea | null = null;
  let bestArea = 0;
  for (const display of displays) {
    const area = intersectionArea(candidate, display);
    if (area > bestArea) {
      bestArea = area;
      bestDisplay = display;
    }
  }

  // 若可见面积不足窗口面积的 25%，视为外接屏已断开，安全回退到主屏居中
  if (!bestDisplay || bestArea < width * height * 0.25) {
    return {
      ...centeredFallback,
      isMaximized: Boolean(saved.isMaximized),
    };
  }

  const clampedWidth = Math.min(width, bestDisplay.width);
  const clampedHeight = Math.min(height, bestDisplay.height);
  const clampedX = Math.max(
    bestDisplay.x,
    Math.min(candidate.x, bestDisplay.x + bestDisplay.width - clampedWidth),
  );
  const clampedY = Math.max(
    bestDisplay.y,
    Math.min(candidate.y, bestDisplay.y + bestDisplay.height - clampedHeight),
  );

  return {
    x: clampedX,
    y: clampedY,
    width: clampedWidth,
    height: clampedHeight,
    isMaximized: Boolean(saved.isMaximized),
  };
}

/** 计算独立浮窗在指定显示器居中坐标（用于全机 SSO 授权弹窗）。 */
export function centerOnDisplay(
  display: DisplayWorkArea,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  const safeW = Math.min(width, display.width);
  const safeH = Math.min(height, display.height);
  return {
    x: Math.round(display.x + (display.width - safeW) / 2),
    y: Math.round(display.y + (display.height - safeH) / 2),
    width: safeW,
    height: safeH,
  };
}
