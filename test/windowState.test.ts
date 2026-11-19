import assert from 'node:assert/strict';
import test from 'node:test';
import {
  centerOnDisplay,
  DEFAULT_MAIN_HEIGHT,
  DEFAULT_MAIN_WIDTH,
  resolveSafeWindowBounds,
} from '../electron/windows/windowState';

const primary = { x: 0, y: 0, width: 1728, height: 1080 };
const secondary = { x: 1728, y: 0, width: 2560, height: 1440 };

test('无历史窗口记录时在主显示器居中返回默认尺寸', () => {
  const bounds = resolveSafeWindowBounds(undefined, [primary], primary);
  assert.equal(bounds.width, DEFAULT_MAIN_WIDTH);
  assert.equal(bounds.height, DEFAULT_MAIN_HEIGHT);
  assert.equal(bounds.x, Math.round((primary.width - DEFAULT_MAIN_WIDTH) / 2));
  assert.equal(bounds.y, Math.round((primary.height - DEFAULT_MAIN_HEIGHT) / 2));
});

test('外接副屏断开后，原副屏上的窗口自动回退到主屏居中', () => {
  const savedOnSecondary = { x: 2000, y: 120, width: 1300, height: 860, isMaximized: false };
  const recovered = resolveSafeWindowBounds(savedOnSecondary, [primary], primary);
  assert.ok(recovered.x >= primary.x && recovered.x + recovered.width <= primary.x + primary.width);
  assert.ok(recovered.y >= primary.y && recovered.y + recovered.height <= primary.y + primary.height);
});

test('副屏在线时保留副屏位置并裁剪到可见工作区', () => {
  const savedOnSecondary = { x: 2100, y: 100, width: 1400, height: 900, isMaximized: true };
  const resolved = resolveSafeWindowBounds(savedOnSecondary, [primary, secondary], primary);
  assert.equal(resolved.x, 2100);
  assert.equal(resolved.y, 100);
  assert.equal(resolved.isMaximized, true);
});

test('独立授权浮窗可在光标所在显示器居中', () => {
  const rect = centerOnDisplay(secondary, 400, 460);
  assert.equal(rect.width, 400);
  assert.equal(rect.height, 460);
  assert.equal(rect.x, 1728 + (2560 - 400) / 2);
});
