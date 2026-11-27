/** Orbit（伴程）Electron 主进程入口：单实例锁、协议注册、三层存储、窗口管理与 IPC 编排。 */
import { app, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, session, shell, systemPreferences } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parseBlogUrl } from '../src/shared/blogUrl';
import { getOrbitEndpoints } from '../src/shared/env';
import {
  ChangePasswordInputSchema,
  DocBoundsSchema,
  MfaVerifyInputSchema,
  OrbitConfigPatchSchema,
  PasswordSignInInputSchema,
  UpdateAvatarUrlInputSchema,
} from '../src/shared/ipc';
import {
  MiniAppBoundsSchema,
  MiniAppDisplayModeSchema,
  MiniAppEngineSchema,
  MiniAppIdSchema,
  MiniAppLaunchRoomContextSchema,
  MiniAppPermissionScopeSchema,
  MiniAppTypeSchema,
  OrbitAppManifestSchema,
} from '../src/shared/miniapp';
import {
  ImportIcsFileInputSchema,
  SaveCalendarCategoryInputSchema,
  SaveCalendarSubscriptionInputSchema,
  UpsertCalendarEventInputSchema,
  UpsertCalendarTaskInputSchema,
} from '../src/shared/calendar';
import {
  fetchIcsSubscription,
  pickAndParseLocalIcsFile,
  syncCnHolidaysData,
} from './schedule/calendarSync';
import {
  ApplySwpuImportInputSchema,
  CreateScheduleInputSchema,
  OrbitSharePackageSchema,
  SaveTimetableInputSchema,
  UpdateScheduleInputSchema,
  UpsertCourseInputSchema,
  buildOrbitSharePackage,
  generateScheduleIcs,
} from '../src/shared/schedule';
import { AuthService } from './auth/authService';
import { parseOrbitProtocolUrl } from './auth/protocol';
import { LocalDocHost } from './doc/localDocHost';
import {
  MiniAppContainerManager,
  registerMiniAppProtocolScheme,
} from './miniapp/containerManager';
import { MiniAppPackageManager } from './miniapp/packageManager';
import { requestMacLocationPermission, scanNearbyWifi } from './network/wifiScanner';
import { SwpuScheduleImporter } from './schedule/swpuImporter';
import { ConfigStore } from './storage/configStore';
import { LocalDB } from './storage/localDb';
import { SecretStore } from './storage/secretStore';
import { TrayManager } from './tray/trayManager';
import { OrbitUpdater } from './updater/releaseUpdater';
import { safeSendToWindow } from './windows/safeSend';
import { WindowManager } from './windows/windowManager';

// 单实例锁：重复启动或 Windows 通过 lec-orbit:// 唤醒时交由已有主实例处理
const isIsolatedDev = !app.isPackaged && process.env.ORBIT_DEV_ISOLATED === '1';
app.setName(isIsolatedDev ? 'Orbit Dev' : 'Orbit');
if (isIsolatedDev) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Orbit Dev'));
}
// 必须在 app.whenReady() 前注册 orbit-app:// 安全标准协议，确保 WebGL/WASM/SharedArrayBuffer 可用
registerMiniAppProtocolScheme();
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function resolveAppIconPath(filename: string): string | undefined {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'icons', filename) : undefined,
    path.resolve(__dirname, '../../resources/icons', filename),
    path.resolve(app.getAppPath(), 'resources/icons', filename),
  ].filter((item): item is string => Boolean(item));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

const PROTOCOL_SCHEME = 'lec-orbit';
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [path.resolve(process.argv[1]!)]);
} else {
  app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
}

let configStore: ConfigStore;
let secretStore: SecretStore;
let localDb: LocalDB;
let localDocHost: LocalDocHost;
let authService: AuthService;
let windowManager: WindowManager;
let trayManager: TrayManager;
let updater: OrbitUpdater;
let miniAppPackageManager: MiniAppPackageManager;
let miniAppContainerManager: MiniAppContainerManager;
let swpuScheduleImporter: SwpuScheduleImporter;

function currentScopeKey(): string {
  const sub = authService?.getState().profile?.subject || 'anonymous';
  return `campus:${sub}`;
}

function handleProtocolUrl(rawUrl: string): void {
  const parsed = parseOrbitProtocolUrl(rawUrl);
  if (!parsed) return;
  windowManager?.showApproveChallengeWindow({
    challengeId: parsed.challengeId,
    receivedAt: Date.now(),
  });
}

function sendToMainWindow(channel: string, ...args: unknown[]): void {
  safeSendToWindow(windowManager?.getMainWindow(), channel, ...args);
}

function registerBlogIpcHandlers(): void {
  const blogUrl = z.string().transform((raw, context) => {
    const url = parseBlogUrl(raw);
    if (url) return url;
    context.addIssue({ code: 'custom', message: '博客仅支持有效的 HTTP 或 HTTPS 地址' });
    return z.NEVER;
  });
  const activation = z.object({ bounds: DocBoundsSchema, url: blogUrl.optional() });
  const handle = (channel: string, listener: (payload: unknown) => unknown) => {
    ipcMain.handle(`orbit:blog:${channel}`, (event, payload) => {
      const win = windowManager.getMainWindow();
      if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
        throw new Error('成员博客 IPC 仅供主窗口使用');
      }
      return listener(payload);
    });
  };
  handle('activate', (raw) => {
    const { bounds, url } = activation.parse(raw);
    miniAppContainerManager?.setWorkspaceBounds({ x: 0, y: 0, width: 0, height: 0 });
    return windowManager.activateBlog(bounds, url);
  });
  handle('deactivate', () => windowManager.blog.deactivate());
  handle('setBounds', (raw) => windowManager.blog.setBounds(DocBoundsSchema.parse(raw)));
  handle('navigate', (raw) => windowManager.blog.navigate(blogUrl.parse(raw)));
  handle('goBack', () => windowManager.blog.goBack());
  handle('goForward', () => windowManager.blog.goForward());
  handle('reload', () => windowManager.blog.reload());
  handle('openExternal', () => windowManager.blog.openExternal());
  handle('getState', () => windowManager.blog.getState());
}

function registerScheduleIpcHandlers(): void {
  const scheduleIdSchema = z.string().min(1).max(80);
  ipcMain.handle('orbit:schedule:listSchedules', () => localDb.listSchedules(currentScopeKey()));
  ipcMain.handle('orbit:schedule:getDetail', (_e, rawId) =>
    localDb.getScheduleDetail(currentScopeKey(), scheduleIdSchema.optional().parse(rawId)),
  );
  ipcMain.handle('orbit:schedule:createSchedule', (_e, raw) =>
    localDb.createSchedule(currentScopeKey(), CreateScheduleInputSchema.parse(raw)),
  );
  ipcMain.handle('orbit:schedule:updateSchedule', (_e, raw) =>
    localDb.updateSchedule(currentScopeKey(), UpdateScheduleInputSchema.parse(raw)),
  );
  ipcMain.handle('orbit:schedule:setActiveSchedule', (_e, rawId) =>
    localDb.setActiveSchedule(currentScopeKey(), scheduleIdSchema.parse(rawId)),
  );
  ipcMain.handle('orbit:schedule:deleteSchedule', (_e, rawId) => {
    localDb.deleteSchedule(currentScopeKey(), scheduleIdSchema.parse(rawId));
  });
  ipcMain.handle('orbit:schedule:clearCourses', (_e, rawId) => {
    localDb.clearScheduleCourses(currentScopeKey(), scheduleIdSchema.parse(rawId));
  });
  ipcMain.handle('orbit:schedule:upsertCourse', (_e, raw) =>
    localDb.upsertCourseWithMeetings(currentScopeKey(), UpsertCourseInputSchema.parse(raw)),
  );
  ipcMain.handle('orbit:schedule:deleteCourses', (_e, raw) => {
    const payload = z
      .object({
        scheduleId: scheduleIdSchema,
        courseIds: z.array(scheduleIdSchema).max(200),
      })
      .parse(raw);
    localDb.deleteCourses(currentScopeKey(), payload.scheduleId, payload.courseIds);
  });
  ipcMain.handle('orbit:schedule:listTimetables', () => localDb.listTimetables(currentScopeKey()));
  ipcMain.handle('orbit:schedule:saveTimetable', (_e, raw) =>
    localDb.saveTimetable(currentScopeKey(), SaveTimetableInputSchema.parse(raw)),
  );
  ipcMain.handle('orbit:schedule:getImportState', () => swpuScheduleImporter.getState());
  ipcMain.handle('orbit:schedule:openSwpuImport', (_e, raw) => {
    const opts = z
      .object({
        networkMode: z.enum(['direct', 'system', 'webvpn']).optional(),
        clearSession: z.boolean().optional(),
      })
      .optional()
      .parse(raw);
    return swpuScheduleImporter.openLoginWindow(opts);
  });
  ipcMain.handle('orbit:schedule:fetchSwpuSchedule', (_e, rawTerm) =>
    swpuScheduleImporter.fetchSchedule(z.string().max(40).optional().parse(rawTerm)),
  );
  ipcMain.handle('orbit:schedule:closeSwpuImport', () => swpuScheduleImporter.close());
  ipcMain.handle('orbit:schedule:applySwpuImport', (_e, raw) => {
    const parsed = ApplySwpuImportInputSchema.parse(raw);
    const detail = localDb.applySwpuImport(currentScopeKey(), parsed);
    swpuScheduleImporter.close();
    return detail;
  });
  ipcMain.handle('orbit:schedule:exportIcs', async (_e, rawId) => {
    const id = scheduleIdSchema.parse(rawId);
    const detail = localDb.getScheduleDetail(currentScopeKey(), id);
    if (!detail) return { ok: false, message: '未找到指定课表' };
    const safeFileName = `${detail.schedule.name.replace(/[\\/:*?"<>|]/g, '_') || 'orbit-schedule'}.ics`;
    const win = windowManager.getMainWindow();
    const picked = win
      ? await dialog.showSaveDialog(win, {
          title: '导出课程表为标准日历 (.ics)',
          defaultPath: safeFileName,
          filters: [{ name: 'iCalendar 日历文件', extensions: ['ics'] }],
        })
      : await dialog.showSaveDialog({
          title: '导出课程表为标准日历 (.ics)',
          defaultPath: safeFileName,
          filters: [{ name: 'iCalendar 日历文件', extensions: ['ics'] }],
        });
    if (picked.canceled || !picked.filePath) {
      return { ok: false, cancelled: true };
    }
    const icsText = generateScheduleIcs(detail);
    fs.writeFileSync(picked.filePath, icsText, 'utf8');
    return { ok: true, filePath: picked.filePath };
  });
  ipcMain.handle('orbit:schedule:exportShareJson', (_e, rawId) => {
    const id = scheduleIdSchema.parse(rawId);
    const detail = localDb.getScheduleDetail(currentScopeKey(), id);
    if (!detail) return { ok: false, message: '未找到指定课表' };
    const pkg = buildOrbitSharePackage(detail);
    const json = JSON.stringify(pkg);
    clipboard.writeText(json);
    return { ok: true, json };
  });
  ipcMain.handle('orbit:schedule:importShareJson', (_e, rawJson) => {
    const text = z.string().min(2).max(500_000).parse(rawJson);
    try {
      const parsed = OrbitSharePackageSchema.parse(JSON.parse(text));
      const detail = localDb.importSharePackage(currentScopeKey(), parsed);
      return { ok: true, detail };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? `分享内容格式无效：${err.message}` : '分享内容格式无效',
      };
    }
  });

  // ── 统一日历（自定义日历分组 + 日程 + 待办任务）IPC ──
  const entityIdSchema = z.string().min(1).max(80);
  ipcMain.handle('orbit:calendar:getSnapshot', () => localDb.getCalendarSnapshot(currentScopeKey()));
  ipcMain.handle('orbit:calendar:saveCategory', (_e, raw) =>
    localDb.saveCalendarCategory(currentScopeKey(), SaveCalendarCategoryInputSchema.parse(raw)),
  );
  ipcMain.handle('orbit:calendar:setCategoryVisible', (_e, raw) => {
    const payload = z.object({ categoryId: entityIdSchema, visible: z.boolean() }).parse(raw);
    localDb.setCalendarCategoryVisible(currentScopeKey(), payload.categoryId, payload.visible);
  });
  ipcMain.handle('orbit:calendar:deleteCategory', (_e, rawId) => {
    localDb.deleteCalendarCategory(currentScopeKey(), entityIdSchema.parse(rawId));
  });
  ipcMain.handle('orbit:calendar:upsertEvent', (_e, raw) =>
    localDb.upsertCalendarEvent(currentScopeKey(), UpsertCalendarEventInputSchema.parse(raw)),
  );
  ipcMain.handle('orbit:calendar:deleteEvent', (_e, rawId) => {
    localDb.deleteCalendarEvent(currentScopeKey(), entityIdSchema.parse(rawId));
  });
  ipcMain.handle('orbit:calendar:upsertTask', (_e, raw) =>
    localDb.upsertCalendarTask(currentScopeKey(), UpsertCalendarTaskInputSchema.parse(raw)),
  );
  ipcMain.handle('orbit:calendar:toggleTask', (_e, raw) => {
    const payload = z.object({ taskId: entityIdSchema, completed: z.boolean() }).parse(raw);
    return localDb.toggleCalendarTask(currentScopeKey(), payload.taskId, payload.completed);
  });
  ipcMain.handle('orbit:calendar:deleteTask', (_e, rawId) => {
    localDb.deleteCalendarTask(currentScopeKey(), entityIdSchema.parse(rawId));
  });

  // ── 订阅日历（默认中国法定节假日 + 外部 .ics/webcal 订阅 + 本地 .ics 导入）──
  const refreshSubscriptionCore = async (scope: string, subscriptionId: string) => {
    const subs = localDb.listCalendarSubscriptions(scope);
    const target = subs.find((s) => s.id === subscriptionId);
    if (!target) throw new Error('订阅日历不存在');

    if (target.kind === 'cn-holiday') {
      try {
        const synced = await syncCnHolidaysData();
        localDb.replaceCalendarSubscriptionItems(scope, target.id, synced.entries, {
          syncedAt: Date.now(),
          error: null,
        });
        const updated =
          localDb.listCalendarSubscriptions(scope).find((s) => s.id === target.id) ?? target;
        return {
          subscription: updated,
          itemCount: synced.entries.length,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : '拉取法定节假日数据失败';
        localDb.markCalendarSubscriptionError(scope, target.id, message);
        throw new Error(message);
      }
    }

    try {
      const fetched = await fetchIcsSubscription(target.url);
      localDb.replaceCalendarSubscriptionItems(scope, target.id, fetched.entries, {
        syncedAt: Date.now(),
        error: null,
      });
      const updated =
        localDb.listCalendarSubscriptions(scope).find((s) => s.id === target.id) ?? target;
      return {
        subscription: updated,
        itemCount: fetched.entries.length,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : '拉取订阅日历失败';
      localDb.markCalendarSubscriptionError(scope, target.id, message);
      throw new Error(message);
    }
  };

  ipcMain.handle('orbit:calendar:saveSubscription', async (_e, raw) => {
    const scope = currentScopeKey();
    const input = SaveCalendarSubscriptionInputSchema.parse(raw);
    const existing = input.id
      ? localDb.listCalendarSubscriptions(scope).find((s) => s.id === input.id)
      : undefined;

    if (existing?.kind === 'cn-holiday') {
      const saved = localDb.saveCalendarSubscription(scope, input);
      const count = localDb
        .listCalendarSubscriptionItems(scope)
        .filter((i) => i.subscriptionId === saved.id).length;
      return { subscription: saved, itemCount: count };
    }

    // 外部 .ics / webcal 订阅：先校验并拉取解析，成功后原子落库，避免存下失效订阅
    const fetched = await fetchIcsSubscription(input.url);
    const saved = localDb.saveCalendarSubscription(scope, {
      ...input,
      name: input.name.trim() || fetched.calendarName || '订阅日历',
      url: fetched.normalizedUrl,
    });
    localDb.replaceCalendarSubscriptionItems(scope, saved.id, fetched.entries, {
      syncedAt: Date.now(),
      error: null,
    });
    const updated =
      localDb.listCalendarSubscriptions(scope).find((s) => s.id === saved.id) ?? saved;
    return {
      subscription: updated,
      itemCount: fetched.entries.length,
    };
  });

  ipcMain.handle('orbit:calendar:refreshSubscription', async (_e, rawId) => {
    return refreshSubscriptionCore(currentScopeKey(), entityIdSchema.parse(rawId));
  });

  ipcMain.handle('orbit:calendar:setSubscriptionVisible', (_e, raw) => {
    const payload = z.object({ subscriptionId: entityIdSchema, visible: z.boolean() }).parse(raw);
    localDb.setCalendarSubscriptionVisible(
      currentScopeKey(),
      payload.subscriptionId,
      payload.visible,
    );
  });

  ipcMain.handle('orbit:calendar:deleteSubscription', (_e, rawId) => {
    localDb.deleteCalendarSubscription(currentScopeKey(), entityIdSchema.parse(rawId));
  });

  ipcMain.handle('orbit:calendar:importIcsFile', async (_e, raw) => {
    const input = ImportIcsFileInputSchema.parse(raw ?? {});
    const picked = await pickAndParseLocalIcsFile(windowManager.getMainWindow());
    if (picked.canceled || !picked.entries) {
      return { canceled: true };
    }
    const imported = localDb.importEntriesAsCalendarCategory(currentScopeKey(), {
      name: input.name?.trim() || picked.calendarName || picked.fileName || '导入日历',
      color: input.color,
      entries: picked.entries,
    });
    return {
      canceled: false,
      category: imported.category,
      importedCount: imported.importedCount,
    };
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle('orbit:auth:getState', () => authService.getState());
  ipcMain.handle('orbit:auth:signInWithPassword', (_e, raw) =>
    authService.signInWithPassword(PasswordSignInInputSchema.parse(raw)),
  );
  ipcMain.handle('orbit:auth:verifyMfa', (_e, raw) =>
    authService.verifyMfa(MfaVerifyInputSchema.parse(raw)),
  );
  ipcMain.handle('orbit:auth:signInWithEmbeddedWindow', () =>
    authService.signInWithEmbeddedWindow(windowManager.getMainWindow()),
  );
  ipcMain.handle('orbit:auth:getApiToken', (_e, rawTarget) => {
    const target = z.enum(['punch', 'orbit']).parse(rawTarget);
    return authService.getApiToken(target);
  });
  ipcMain.handle('orbit:auth:pickAndUploadAvatar', async () => {
    const win = windowManager.getMainWindow();
    const picked = win
      ? await dialog.showOpenDialog(win, {
          title: '选择新头像',
          properties: ['openFile'],
          filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
        })
      : await dialog.showOpenDialog({
          title: '选择新头像',
          properties: ['openFile'],
          filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
        });
    if (picked.canceled || !picked.filePaths[0]) {
      return { ok: false, cancelled: true };
    }
    return authService.uploadAvatarFromFile(picked.filePaths[0]);
  });
  ipcMain.handle('orbit:auth:updateAvatarUrl', (_e, raw) =>
    authService.updateAvatarUrl(UpdateAvatarUrlInputSchema.parse(raw).avatarUrl),
  );
  ipcMain.handle('orbit:auth:changePassword', (_e, raw) =>
    authService.changePassword(ChangePasswordInputSchema.parse(raw)),
  );
  ipcMain.handle('orbit:auth:getSocialConnections', () => authService.getSocialConnections());
  ipcMain.handle('orbit:auth:listStudioMembers', () => authService.listStudioMembers());
  ipcMain.handle('orbit:auth:signOut', async () => {
    const scope = currentScopeKey();
    const state = await authService.signOut();
    localDb.clearScope(scope);
    await swpuScheduleImporter?.resetForSignOut();
    return state;
  });

  ipcMain.handle('orbit:doc:activate', (_e, raw) => {
    const payload = z.object({ bounds: DocBoundsSchema, url: z.string().url().optional() }).parse(raw);
    return windowManager.activateDoc(payload.bounds, payload.url);
  });
  ipcMain.handle('orbit:doc:deactivate', () => windowManager.deactivateDoc());
  ipcMain.handle('orbit:doc:setBounds', (_e, raw) =>
    windowManager.setDocBounds(DocBoundsSchema.parse(raw)),
  );
  ipcMain.handle('orbit:doc:setOverlayVisible', (_e, raw) => {
    const visible = z.boolean().parse(raw);
    windowManager.setOverlayVisible(visible);
    miniAppContainerManager?.setOverlayVisible(visible);
  });
  ipcMain.handle('orbit:doc:navigate', (_e, raw) =>
    windowManager.navigateDoc(z.string().url().parse(raw)),
  );
  ipcMain.handle('orbit:doc:goBack', () => windowManager.docGoBack());
  ipcMain.handle('orbit:doc:goForward', () => windowManager.docGoForward());
  ipcMain.handle('orbit:doc:reload', () => windowManager.docReload());
  ipcMain.handle('orbit:doc:openExternal', () => windowManager.openDocExternal());
  ipcMain.handle('orbit:doc:getState', () => windowManager.getDocState());
  ipcMain.handle('orbit:doc:listRecents', (_e, rawQuery) =>
    localDb.listDocRecents(currentScopeKey(), z.string().optional().parse(rawQuery)),
  );
  registerBlogIpcHandlers();
  registerScheduleIpcHandlers();

  ipcMain.handle('orbit:storage:getCache', (_e, rawKey) =>
    localDb.getCache(currentScopeKey(), z.string().min(1).max(120).parse(rawKey)),
  );
  ipcMain.handle('orbit:storage:setCache', (_e, raw) => {
    const payload = z.object({ key: z.string().min(1).max(120), value: z.unknown() }).parse(raw);
    localDb.setCache(currentScopeKey(), payload.key, payload.value);
  });
  ipcMain.handle('orbit:storage:getWeeklyDraft', (_e, rawWeek) =>
    localDb.getWeeklyDraft(currentScopeKey(), z.string().regex(/^\d{4}-W\d{2}$/).parse(rawWeek)),
  );
  ipcMain.handle('orbit:storage:saveWeeklyDraft', (_e, raw) => {
    const payload = z
      .object({ week: z.string().regex(/^\d{4}-W\d{2}$/), content: z.string().max(100_000) })
      .parse(raw);
    return localDb.saveWeeklyDraft(currentScopeKey(), payload.week, payload.content);
  });
  ipcMain.handle('orbit:storage:clearUserCache', () => {
    localDb.clearScope(currentScopeKey());
  });

  ipcMain.handle('orbit:system:getConfig', () => configStore.get());
  ipcMain.handle('orbit:system:updateConfig', (_e, rawPatch) => {
    const prev = configStore.get();
    const next = configStore.update(OrbitConfigPatchSchema.parse(rawPatch));
    if (prev.theme !== next.theme) {
      windowManager.syncTheme(next.theme);
      miniAppContainerManager?.syncTheme(next.theme);
    }
    if (prev.globalShortcut !== next.globalShortcut) {
      trayManager.registerShortcut(next.globalShortcut);
    }
    if (prev.floatingBallEnabled !== next.floatingBallEnabled) {
      windowManager.syncFloatingBallEnabled(next.floatingBallEnabled);
      trayManager.setFloatingBallEnabled(next.floatingBallEnabled);
    }
    if (prev.autoLaunch !== next.autoLaunch && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: next.autoLaunch });
    }
    return next;
  });
  ipcMain.handle('orbit:system:openExternal', (_e, rawUrl) => {
    const url = z.string().url().parse(rawUrl);
    if (!url.startsWith('https://') && !url.startsWith('http://')) {
      throw new Error('仅允许打开 HTTP/HTTPS 链接。');
    }
    return shell.openExternal(url);
  });
  ipcMain.handle('orbit:system:copyText', (_e, rawText) => {
    clipboard.writeText(z.string().max(50_000).parse(rawText));
  });
  ipcMain.handle('orbit:system:notify', (_e, raw) => {
    const payload = z.object({ title: z.string().min(1).max(120), body: z.string().max(400) }).parse(raw);
    if (Notification.isSupported()) {
      const notif = new Notification({ title: payload.title, body: payload.body });
      notif.on('click', () => {
        windowManager.showMainWindow();
      });
      notif.show();
    }
  });
  ipcMain.handle('orbit:system:updateTrayPunch', (_e, raw) => {
    const summary = z
      .object({
        checkedIn: z.boolean(),
        elapsedSeconds: z.number().min(0),
        todaySeconds: z.number().min(0).optional(),
        weekSeconds: z.number().min(0).optional(),
        weekTargetSeconds: z.number().min(0).optional(),
        networkAllowed: z.boolean().optional(),
        authenticated: z.boolean().optional(),
        statusLabel: z.string().max(60),
      })
      .parse(raw);
    trayManager.updatePunchSummary(summary);
    windowManager.updateFloatingPunchSummary(summary);
  });
  ipcMain.handle('orbit:system:scanWifi', (_e, raw) => {
    const options = z
      .object({
        samples: z.number().int().min(1).max(5).optional(),
        force: z.boolean().optional(),
      })
      .optional()
      .parse(raw);
    return scanNearbyWifi(options);
  });
  ipcMain.handle('orbit:system:openLocationSettings', async () => {
    if (process.platform === 'darwin') {
      requestMacLocationPermission();
    }
    const targetUrl =
      process.platform === 'win32'
        ? 'ms-settings:privacy-location'
        : process.platform === 'darwin'
          ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices'
          : '';
    if (!targetUrl) return false;
    await shell.openExternal(targetUrl);
    return true;
  });
  ipcMain.handle('orbit:system:getUpdateState', () => updater.getState());
  ipcMain.handle('orbit:system:checkUpdate', () => updater.check());
  ipcMain.handle('orbit:system:downloadUpdate', () => updater.download());
  ipcMain.handle('orbit:system:installUpdate', () => updater.installAndRestart());
  ipcMain.handle('orbit:system:getVersionChangelog', (_e, version?: string) =>
    updater.getVersionChangelog(version),
  );

  // 来自内嵌 LecDoc 的极简只读桥接事件（同步页面上下文 & 触发原生申请编辑权弹窗）
  ipcMain.on('orbit:doc-bridge:pageContext', (_e, raw) => {
    const parsed = z
      .object({
        pageId: z.string().max(128).optional(),
        pageSlug: z.string().max(256).optional(),
        pageTitle: z.string().max(256).optional(),
        canEdit: z.boolean().optional(),
        spaceName: z.string().max(128).optional(),
      })
      .safeParse(raw);
    if (parsed.success) {
      windowManager.updateDocPageContext(parsed.data);
    }
  });

  ipcMain.on('orbit:doc-bridge:requestEdit', (_e, raw) => {
    const parsed = z
      .object({
        pageId: z.string().max(128).optional(),
        pageSlug: z.string().max(256).optional(),
        pageTitle: z.string().max(256).optional(),
        reason: z.string().max(500).optional(),
      })
      .safeParse(raw);
    if (parsed.success) {
      sendToMainWindow('orbit:doc:editRequestTriggered', parsed.data);
    }
  });

  ipcMain.handle('orbit:approve:getChallenge', (_e, rawId) =>
    authService.fetchApproveChallenge(z.string().min(16).max(128).parse(rawId)),
  );
  ipcMain.handle('orbit:approve:decide', (_e, raw) => {
    const payload = z
      .object({
        challengeId: z.string().min(16).max(128),
        action: z.enum(['approve', 'deny']),
      })
      .parse(raw);
    return authService.submitApproveDecision(payload.challengeId, payload.action);
  });
  ipcMain.handle('orbit:approve:closeWindow', () => windowManager.closeApproveWindow());
  ipcMain.handle('orbit:approve:promptBiometric', async (_e, rawReason) => {
    const reason = z.string().min(1).max(120).parse(rawReason);
    if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
      try {
        await systemPreferences.promptTouchID(reason);
        return true;
      } catch {
        return false;
      }
    }
    return true;
  });

  ipcMain.handle('orbit:floating:getState', () => windowManager.getFloatingState());
  ipcMain.handle('orbit:floating:setExpanded', (_e, raw) =>
    windowManager.setFloatingBallExpanded(z.boolean().parse(raw)),
  );
  ipcMain.handle('orbit:floating:moveTo', (_e, raw) => {
    const pos = z.object({ x: z.number(), y: z.number() }).parse(raw);
    windowManager.moveFloatingBall(pos.x, pos.y);
  });
  ipcMain.handle('orbit:floating:snapToEdge', () => windowManager.snapFloatingBallToEdge());
  ipcMain.handle('orbit:floating:togglePunch', () => {
    sendToMainWindow('orbit:system:quickPunch');
  });
  ipcMain.handle('orbit:floating:openMain', () => {
    windowManager.setFloatingBallExpanded(false);
    windowManager.showMainWindow();
  });

  // ── 工坊（小程序 + 小游戏容器）IPC ──
  ipcMain.handle('orbit:hub:listBuiltins', () => miniAppPackageManager.listBuiltins());
  ipcMain.handle('orbit:hub:listInstalled', () => miniAppPackageManager.listInstalled());
  ipcMain.handle('orbit:hub:getRuntimeSnapshot', () => miniAppContainerManager.getRuntimeSnapshot());

  ipcMain.handle('orbit:hub:launch', (_e, raw) => {
    const payload = z
      .object({
        appId: MiniAppIdSchema,
        mode: MiniAppDisplayModeSchema.optional(),
        remoteBundle: z
          .object({
            version: z.string().min(1).max(64),
            bundleUrl: z.string().url(),
            bundleSha256: z.string().max(128).default(''),
            bundleSize: z.number().int().min(0).optional(),
            manifest: OrbitAppManifestSchema.optional(),
            iconUrl: z.string().optional(),
          })
          .optional(),
        launchRoom: MiniAppLaunchRoomContextSchema.optional(),
      })
      .parse(raw);
    return miniAppContainerManager.launch(payload);
  });

  ipcMain.handle('orbit:hub:launchLocalDir', (_e, raw) => {
    const payload = z
      .object({
        dirPath: z.string().min(1).max(1024),
        mode: MiniAppDisplayModeSchema.optional(),
      })
      .parse(raw);
    return miniAppContainerManager.launchLocalDir(payload);
  });

  ipcMain.handle('orbit:hub:launchDevUrl', (_e, raw) => {
    const payload = z
      .object({
        appId: MiniAppIdSchema,
        name: z.string().trim().min(1).max(48),
        url: z.string().url(),
        type: MiniAppTypeSchema.optional(),
        engine: MiniAppEngineSchema.optional(),
        mode: MiniAppDisplayModeSchema.optional(),
        crossOriginIsolated: z.boolean().optional(),
      })
      .parse(raw);
    return miniAppContainerManager.launchDevUrl(payload);
  });

  ipcMain.handle('orbit:hub:switchMode', (_e, raw) => {
    const payload = z
      .object({
        appId: MiniAppIdSchema,
        mode: MiniAppDisplayModeSchema,
      })
      .parse(raw);
    if (payload.mode === 'workspace') {
      windowManager.blog.deactivate();
    }
    return miniAppContainerManager.switchMode(payload.appId, payload.mode);
  });

  ipcMain.handle('orbit:hub:close', (_e, rawAppId) => {
    miniAppContainerManager.close(MiniAppIdSchema.parse(rawAppId));
  });

  ipcMain.handle('orbit:hub:reload', (_e, rawAppId) => {
    miniAppContainerManager.reload(MiniAppIdSchema.parse(rawAppId));
  });

  ipcMain.handle('orbit:hub:openDevTools', (_e, rawAppId) => {
    miniAppContainerManager.openDevTools(MiniAppIdSchema.parse(rawAppId));
  });

  ipcMain.handle('orbit:hub:toggleFullscreen', (_e, rawAppId) => {
    miniAppContainerManager.toggleFullscreen(MiniAppIdSchema.parse(rawAppId));
  });

  ipcMain.handle('orbit:hub:setSidepanelBounds', (_e, raw) => {
    const payload = z
      .object({
        bounds: MiniAppBoundsSchema,
        width: z.number().int().min(320).max(640).optional(),
      })
      .parse(raw);
    miniAppContainerManager.setSidepanelBounds(payload.bounds, payload.width);
  });

  ipcMain.handle('orbit:hub:setWorkspaceBounds', (_e, rawBounds) => {
    const bounds = MiniAppBoundsSchema.parse(rawBounds);
    if (bounds.width > 0 && bounds.height > 0) {
      windowManager.blog.deactivate();
    }
    miniAppContainerManager.setWorkspaceBounds(bounds);
  });

  ipcMain.handle('orbit:hub:dispatchRealtime', (_e, raw) => {
    const payload = z
      .object({
        appId: MiniAppIdSchema,
        roomId: z.string().nullable().optional(),
        event: z.string().min(1).max(128),
        payload: z.unknown().optional(),
        ts: z.number().optional(),
      })
      .parse(raw);
    miniAppContainerManager.dispatchRealtimeEvent(payload);
  });

  ipcMain.handle('orbit:hub:uninstall', (_e, rawAppId) => {
    const appId = MiniAppIdSchema.parse(rawAppId);
    miniAppContainerManager.close(appId);
    miniAppPackageManager.uninstall(appId);
  });

  ipcMain.handle('orbit:hub:clearCache', () => {
    miniAppContainerManager.destroyAll();
    return miniAppPackageManager.clearAllCache();
  });

  ipcMain.handle('orbit:hub:pickLocalDir', async () => {
    const win = windowManager.getMainWindow();
    const picked = win
      ? await dialog.showOpenDialog(win, {
          title: '选择包含 orbit.manifest.json 的应用目录',
          properties: ['openDirectory'],
        })
      : await dialog.showOpenDialog({
          title: '选择包含 orbit.manifest.json 的应用目录',
          properties: ['openDirectory'],
        });
    if (picked.canceled || !picked.filePaths[0]) {
      return { ok: false, cancelled: true };
    }
    try {
      const dirPath = picked.filePaths[0];
      const manifest = miniAppPackageManager.readLocalDirManifest(dirPath);
      return { ok: true, dirPath, manifest };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : '读取目录清单失败',
      };
    }
  });

  ipcMain.handle('orbit:hub:pickZipFile', async () => {
    const win = windowManager.getMainWindow();
    const picked = win
      ? await dialog.showOpenDialog(win, {
          title: '选择工坊构建包（.zip / .lecapp）',
          properties: ['openFile'],
          filters: [{ name: '工坊构建包', extensions: ['zip', 'lecapp'] }],
        })
      : await dialog.showOpenDialog({
          title: '选择工坊构建包（.zip / .lecapp）',
          properties: ['openFile'],
          filters: [{ name: '工坊构建包', extensions: ['zip', 'lecapp'] }],
        });
    if (picked.canceled || !picked.filePaths[0]) {
      return { ok: false, cancelled: true };
    }
    try {
      const filePath = picked.filePaths[0];
      const { manifest, sizeBytes } = miniAppPackageManager.inspectLocalZipFile(filePath);
      return {
        ok: true,
        filePath,
        fileName: path.basename(filePath),
        sizeBytes,
        manifest,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : '校验构建包失败',
      };
    }
  });

  ipcMain.handle('orbit:hub:readZipFileBase64', (_e, rawFilePath) => {
    const filePath = z.string().min(1).max(1024).parse(rawFilePath);
    const { sizeBytes } = miniAppPackageManager.inspectLocalZipFile(filePath);
    const buf = fs.readFileSync(filePath);
    return {
      base64: buf.toString('base64'),
      fileName: path.basename(filePath),
      sizeBytes,
    };
  });

  ipcMain.handle('orbit:hub:getAppPref', (_e, rawAppId) =>
    localDb.getAppPref(currentScopeKey(), MiniAppIdSchema.parse(rawAppId)),
  );

  ipcMain.handle('orbit:hub:setAppPref', (_e, raw) => {
    const payload = z
      .object({
        appId: MiniAppIdSchema,
        patch: z.object({
          preferredMode: MiniAppDisplayModeSchema.optional(),
          sidepanelWidth: z.number().int().min(320).max(640).optional(),
          pinned: z.boolean().optional(),
          grantedScopes: z.array(MiniAppPermissionScopeSchema).optional(),
          lastOpenedAt: z.number().int().min(0).optional(),
        }),
      })
      .parse(raw);
    return localDb.setAppPref(currentScopeKey(), payload.appId, payload.patch);
  });

  ipcMain.handle('orbit:hub:listAppPrefs', () => localDb.listAppPrefs(currentScopeKey()));
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleProtocolUrl(url);
});

app.on('second-instance', (_event, argv) => {
  const protocolArg = argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`));
  if (protocolArg) {
    handleProtocolUrl(protocolArg);
    return;
  }
  windowManager?.showMainWindow();
});

let cleanedUp = false;
function cleanupBeforeQuit(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  const safe = (fn: () => void) => {
    try {
      fn();
    } catch {
      // 退出阶段忽略单步清理异常，避免 Electron 弹出未捕获异常框
    }
  };
  safe(() => windowManager?.markQuitting());
  safe(() => windowManager?.blog.destroy());
  safe(() => swpuScheduleImporter?.destroy());
  safe(() => miniAppContainerManager?.destroyAll());
  safe(() => windowManager?.destroyFloatingBallWindow());
  safe(() => updater?.stopAutoCheck());
  safe(() => localDocHost?.stop());
  safe(() => authService?.dispose());
  safe(() => trayManager?.dispose());
  safe(() => localDb?.close());
}

app.on('before-quit', () => {
  cleanupBeforeQuit();
});

app.on('activate', () => {
  windowManager?.showMainWindow();
});

/** 本次运行中已由用户显式确认允许的教务非认证域名证书例外集合。 */
const approvedSwpuTlsHosts = new Set<string>();
const SWPU_AUTH_HOST_RE = /^(?:sso|auth|ids|cas|login)(?:[-.].*)?\.swpu\.edu\.cn$/i;

// 严禁对统一身份认证域（sso.swpu.edu.cn 等）静默放行 TLS 证书错误；其余校内教务子域需经用户显式确认
app.on('certificate-error', (event, wc, url, error, cert, callback) => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const isSwpuSubdomain = host === 'swpu.edu.cn' || host.endsWith('.swpu.edu.cn');
    if (swpuScheduleImporter?.ownsWebContents(wc) && isSwpuSubdomain) {
      if (SWPU_AUTH_HOST_RE.test(host)) {
        console.warn(`[orbit:tls] 拒绝静默放行认证域名证书错误: host=${host} error=${error}`);
        callback(false);
        return;
      }
      if (approvedSwpuTlsHosts.has(host)) {
        event.preventDefault();
        callback(true);
        return;
      }
      event.preventDefault();
      const ownerWin = windowManager?.getMainWindow();
      const promptOpts: Electron.MessageBoxOptions = {
        type: 'warning',
        title: '教务站点证书校验异常',
        message: `目标教务站点 ${host} 的 HTTPS 证书未通过系统校验（${error}）。`,
        detail: `证书主体：${cert?.subjectName || '未知'}\n签发方：${cert?.issuerName || '未知'}\n若你在公共 Wi-Fi 下看到此提示，可能存在中间人劫持风险，建议取消连接。`,
        buttons: ['取消连接（推荐）', '仅本次信任并继续'],
        defaultId: 0,
        cancelId: 0,
      };
      const ask = ownerWin
        ? dialog.showMessageBox(ownerWin, promptOpts)
        : dialog.showMessageBox(promptOpts);
      void ask
        .then((res) => {
          if (res.response === 1) {
            approvedSwpuTlsHosts.add(host);
            callback(true);
          } else {
            callback(false);
          }
        })
        .catch(() => callback(false));
      return;
    }
  } catch {
    // 忽略非法 URL
  }
  callback(false);
});

app.whenReady().then(async () => {
  if (!gotLock) return;
  // macOS Dock 图标与原生应用菜单栏（保证 Dock 图标常驻、Cmd+Tab 可见、聚焦窗口时左上角显示 Orbit）
  if (process.platform === 'darwin') {
    if (app.dock) {
      const dockIconPath = resolveAppIconPath('dock-icon.png') ?? resolveAppIconPath('icon.png');
      if (dockIconPath) {
        const dockImage = nativeImage.createFromPath(dockIconPath);
        if (!dockImage.isEmpty()) {
          app.dock.setIcon(dockImage);
        }
      }
      void app.dock.show();
    }
    const macMenu = Menu.buildFromTemplate([
      {
        label: 'Orbit',
        submenu: [
          { role: 'about', label: '关于 Orbit' },
          { type: 'separator' },
          { role: 'services', label: '服务' },
          { type: 'separator' },
          { role: 'hide', label: '隐藏 Orbit' },
          { role: 'hideOthers', label: '隐藏其他' },
          { role: 'unhide', label: '全部显示' },
          { type: 'separator' },
          {
            label: '退出 Orbit',
            accelerator: 'Command+Q',
            click: () => {
              windowManager?.markQuitting();
              app.quit();
            },
          },
        ],
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'selectAll', label: '全选' },
        ],
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload', label: '重新加载' },
          { role: 'forceReload', label: '强制重新加载' },
          { type: 'separator' },
          { role: 'resetZoom', label: '实际大小' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: '进入全屏幕' },
        ],
      },
      {
        label: '窗口',
        submenu: [
          { role: 'minimize', label: '最小化' },
          { role: 'zoom', label: '缩放' },
          { type: 'separator' },
          { role: 'front', label: '前置全部窗口' },
          { role: 'close', label: '关闭窗口' },
        ],
      },
    ]);
    Menu.setApplicationMenu(macMenu);
  }

  // 博客 API 只向主渲染进程开放配置的源。外部博客视图使用独立 session。
  const isDevRenderer = Boolean(process.env.ELECTRON_RENDERER_URL);
  const blogApiOrigin = new URL(getOrbitEndpoints().blogApiBase).origin;
  const cspHeader = isDevRenderer
    ? `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://sso.lecspace.top https://punch.lecspace.top https://doc.lecspace.top https://orbit.lecspace.top wss://orbit.lecspace.top ${blogApiOrigin} http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*;`
    : `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://sso.lecspace.top https://punch.lecspace.top https://doc.lecspace.top https://orbit.lecspace.top wss://orbit.lecspace.top ${blogApiOrigin};`;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [cspHeader],
      },
    });
  });

  const userDataDir = app.getPath('userData');
  configStore = new ConfigStore(userDataDir);
  secretStore = new SecretStore(userDataDir);
  localDb = new LocalDB(userDataDir);
  localDocHost = new LocalDocHost();
  await localDocHost.start();
  authService = new AuthService(secretStore, configStore);
  updater = new OrbitUpdater({
    onBeforeInstall: () => {
      cleanupBeforeQuit();
    },
  });

  // electron-vite 输出结构：out/main/index.js、out/preload/index.js、out/preload/docPreload.js、out/preload/miniAppPreload.js、out/renderer/index.html
  const preloadPath = path.join(__dirname, '../preload/index.js');
  const docPreloadPath = path.join(__dirname, '../preload/docPreload.js');
  const miniAppPreloadPath = path.join(__dirname, '../preload/miniAppPreload.js');
  const htmlPath = path.join(__dirname, '../renderer/index.html');
  const appIconPath = resolveAppIconPath('icon.png');
  const builtinSeedDirs = [
    process.resourcesPath ? path.join(process.resourcesPath, 'seed-apps') : '',
    path.resolve(__dirname, '../../resources/seed-apps'),
    path.resolve(app.getAppPath(), 'resources/seed-apps'),
  ].filter(Boolean);
  miniAppPackageManager = new MiniAppPackageManager(userDataDir, localDb, builtinSeedDirs);

  windowManager = new WindowManager(
    configStore,
    localDb,
    currentScopeKey,
    () => authService.getState().authenticated,
    preloadPath,
    docPreloadPath,
    localDocHost,
    {
      devUrl: process.env.ELECTRON_RENDERER_URL,
      htmlPath,
      iconPath: appIconPath,
    },
    async (challengeId) => {
      try {
        await authService.submitApproveDecision(challengeId, 'approve');
        return true;
      } catch (err) {
        console.error('[orbit:main] silent approveInternalDocSignIn failed:', err);
        return false;
      }
    },
  );

  trayManager = new TrayManager({
    onShowMain: () => windowManager.showMainWindow(),
    onQuickPunch: () => sendToMainWindow('orbit:system:quickPunch'),
    onToggleFloatingBall: () => {
      const next = configStore.update({
        floatingBallEnabled: !configStore.get().floatingBallEnabled,
      });
      windowManager.syncFloatingBallEnabled(next.floatingBallEnabled);
      trayManager.setFloatingBallEnabled(next.floatingBallEnabled);
    },
    onQuit: () => {
      windowManager.markQuitting();
      app.quit();
    },
  });

  miniAppContainerManager = new MiniAppContainerManager({
    packageManager: miniAppPackageManager,
    localDb,
    getScopeKey: currentScopeKey,
    getAuthState: () => authService.getState(),
    getOrbitApiToken: () => authService.getApiToken('orbit'),
    getMainWindow: () => windowManager.getMainWindow(),
    showMainWindow: () => windowManager.showMainWindow(),
    mainPreloadPath: preloadPath,
    miniAppPreloadPath,
    rendererEntry: {
      devUrl: process.env.ELECTRON_RENDERER_URL,
      htmlPath,
      iconPath: appIconPath,
    },
    onToastRequested: (payload) => {
      sendToMainWindow('orbit:hub:toastRequested', payload);
    },
  });
  miniAppContainerManager.registerSdkIpcHandlers();
  miniAppContainerManager.onRuntimeChanged((snapshot) => {
    sendToMainWindow('orbit:hub:runtimeChanged', snapshot);
  });

  swpuScheduleImporter = new SwpuScheduleImporter(
    () => windowManager.getMainWindow(),
    (state) => {
      sendToMainWindow('orbit:schedule:importStateChanged', state);
    },
  );

  registerIpcHandlers();

  let lastAuthSubject = authService.getState().profile?.subject ?? null;
  authService.onStateChanged((state) => {
    const nextSubject = state.authenticated ? (state.profile?.subject ?? null) : null;
    if (!state.authenticated || (lastAuthSubject && nextSubject && lastAuthSubject !== nextSubject)) {
      void swpuScheduleImporter?.resetForSignOut();
    }
    lastAuthSubject = nextSubject;
    windowManager.onAuthSessionUpdated(state.authenticated);
    windowManager.updateFloatingPunchSummary({
      ...windowManager.getFloatingState(),
      authenticated: state.authenticated,
    });
    sendToMainWindow('orbit:auth:stateChanged', state);
  });
  windowManager.onDocStateChanged((state) => {
    sendToMainWindow('orbit:doc:stateChanged', state);
  });
  updater.onStateChanged((state) => {
    sendToMainWindow('orbit:system:updateState', state);
  });

  const initialCfg = configStore.get();
  windowManager.syncTheme(initialCfg.theme);
  miniAppContainerManager.syncTheme(initialCfg.theme);
  nativeTheme.on('updated', () => {
    miniAppContainerManager?.syncTheme(configStore.get().theme);
  });
  windowManager.createMainWindow();
  // 任意主窗口重新聚焦时节流复查更新（15 分钟内不重复请求），避免常驻托盘或重建窗口后错过发版
  app.on('browser-window-focus', () => {
    void updater?.checkIfStale(15 * 60 * 1000);
  });
  trayManager.init(initialCfg.globalShortcut);
  trayManager.setFloatingBallEnabled(initialCfg.floatingBallEnabled);
  windowManager.syncFloatingBallEnabled(initialCfg.floatingBallEnabled);
  updater.startAutoCheck();
  await authService.restoreSession();
});
