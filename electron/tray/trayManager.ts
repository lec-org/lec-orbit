/** 系统托盘与全局快捷键管理：托盘实时显示 LecPunch 打卡时长并支持一键唤起。 */
import { app, globalShortcut, Menu, nativeImage, Tray } from 'electron';
import type { TrayPunchSummary } from '../../src/shared/ipc';
import { formatClockDuration } from '../../src/shared/punch';

// 16x16 简洁星环模板图标（SVG data URL，macOS 自动适配明暗菜单栏）
const TRAY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18" fill="none">
  <circle cx="9" cy="9" r="3" fill="#000"/>
  <ellipse cx="9" cy="9" rx="7.2" ry="3.8" transform="rotate(-24 9 9)" stroke="#000" stroke-width="1.6"/>
</svg>`;

export class TrayManager {
  private tray: Tray | null = null;
  private registeredShortcut: string | null = null;
  private summary: TrayPunchSummary = {
    checkedIn: false,
    elapsedSeconds: 0,
    statusLabel: '未打卡',
  };

  private floatingBallEnabled = true;

  constructor(
    private readonly handlers: {
      onShowMain: () => void;
      onQuickPunch: () => void;
      onToggleFloatingBall: () => void;
      onQuit: () => void;
    },
  ) {}

  setFloatingBallEnabled(enabled: boolean): void {
    this.floatingBallEnabled = enabled;
    this.rebuildMenu();
  }

  init(shortcut: string): void {
    const icon = nativeImage.createFromDataURL(
      `data:image/svg+xml;base64,${Buffer.from(TRAY_ICON_SVG).toString('base64')}`,
    );
    if (process.platform === 'darwin') {
      icon.setTemplateImage(true);
    }
    this.tray = new Tray(icon);
    this.tray.setToolTip('Orbit · 伴程');
    this.tray.on('click', () => this.handlers.onShowMain());
    this.rebuildMenu();
    this.registerShortcut(shortcut);
  }

  updatePunchSummary(summary: TrayPunchSummary): void {
    this.summary = summary;
    if (this.tray) {
      const clock = summary.checkedIn ? ` ${formatClockDuration(summary.elapsedSeconds)}` : '';
      if (process.platform === 'darwin') {
        this.tray.setTitle(summary.checkedIn ? clock : '');
      }
      this.tray.setToolTip(
        summary.checkedIn ? `Orbit · 专注中${clock}` : `Orbit · ${summary.statusLabel}`,
      );
      this.rebuildMenu();
    }
  }

  registerShortcut(shortcut: string): void {
    if (this.registeredShortcut) {
      globalShortcut.unregister(this.registeredShortcut);
      this.registeredShortcut = null;
    }
    if (!shortcut.trim()) return;
    try {
      const ok = globalShortcut.register(shortcut, () => {
        this.handlers.onShowMain();
      });
      if (ok) this.registeredShortcut = shortcut;
    } catch {
      // 快捷键冲突时静默跳过，避免影响主程序启动
    }
  }

  private rebuildMenu(): void {
    if (!this.tray) return;
    const statusText = this.summary.checkedIn
      ? `专注计时中：${formatClockDuration(this.summary.elapsedSeconds)}`
      : `当前状态：${this.summary.statusLabel}`;
    const menu = Menu.buildFromTemplate([
      { label: statusText, enabled: false },
      { type: 'separator' },
      { label: '打开工作台', click: () => this.handlers.onShowMain() },
      {
        label: this.summary.checkedIn ? '快捷签退' : '快捷签到',
        click: () => {
          this.handlers.onQuickPunch();
        },
      },
      {
        label: this.floatingBallEnabled ? '隐藏打卡悬浮球' : '显示打卡悬浮球',
        click: () => this.handlers.onToggleFloatingBall(),
      },
      { type: 'separator' },
      { label: `退出 (${app.getVersion()})`, click: () => this.handlers.onQuit() },
    ]);
    this.tray.setContextMenu(menu);
  }

  dispose(): void {
    if (this.registeredShortcut) {
      try {
        globalShortcut.unregister(this.registeredShortcut);
      } catch {
        // 忽略退出阶段快捷键注销异常
      }
      this.registeredShortcut = null;
    }
    if (this.tray) {
      try {
        this.tray.destroy();
      } catch {
        // 忽略重复销毁异常
      }
      this.tray = null;
    }
  }
}
