import { z } from 'zod';
import type {
  InstalledMiniAppRecord,
  MiniAppBounds,
  MiniAppBuiltinItem,
  MiniAppDisplayMode,
  MiniAppLaunchDevUrlInput,
  MiniAppLaunchInput,
  MiniAppLaunchLocalDirInput,
  MiniAppRuntimeSnapshot,
  MiniAppUserPref,
  OrbitAppManifest,
  RunningMiniAppState,
} from './miniapp';
import type {
  ApplySwpuImportInput,
  CreateScheduleInput,
  OrbitSharePackage,
  SaveTimetableInput,
  ScheduleCourseWithMeetings,
  ScheduleDetail,
  ScheduleSummary,
  ScheduleTimetable,
  SwpuImportWindowState,
  SwpuNetworkMode,
  UpdateScheduleInput,
  UpsertCourseInput,
} from './schedule';
import type {
  CalendarCategory,
  CalendarEvent,
  CalendarSnapshot,
  CalendarSubscription,
  CalendarTask,
  ImportIcsFileInput,
  ImportIcsFileResult,
  SaveCalendarCategoryInput,
  SaveCalendarSubscriptionInput,
  UpsertCalendarEventInput,
  UpsertCalendarTaskInput,
} from './calendar';
import type { UpdateChangelog } from './updateChangelog';

export type { UpdateChangelog };

export const ThemePreferenceSchema = z.enum(['system', 'light', 'dark']);
export type ThemePreference = z.infer<typeof ThemePreferenceSchema>;

export const WindowBoundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(720),
  height: z.number().int().min(520),
  isMaximized: z.boolean().default(false),
});
export type WindowBounds = z.infer<typeof WindowBoundsSchema>;

export const ScheduledReminderSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(60),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  enabled: z.boolean(),
});
export type ScheduledReminder = z.infer<typeof ScheduledReminderSchema>;

export const FloatingPositionSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
});
export type FloatingPosition = z.infer<typeof FloatingPositionSchema>;

export const AuthUserProfileSchema = z.object({
  issuer: z.string(),
  subject: z.string(),
  username: z.string().optional(),
  name: z.string().optional(),
  avatar: z.string().optional(),
  organizations: z.array(z.string()).default([]),
  organizationRoles: z.array(z.string()).default([]),
});
export type AuthUserProfile = z.infer<typeof AuthUserProfileSchema>;

export const OrbitConfigSchema = z.object({
  schemaVersion: z.number().int().default(1),
  theme: ThemePreferenceSchema.default('system'),
  closeToTray: z.boolean().default(true),
  autoLaunch: z.boolean().default(false),
  remindersEnabled: z.boolean().default(true),
  frenzyFlamesEnabled: z.boolean().default(true),
  floatingBallEnabled: z.boolean().default(true),
  floatingBallPosition: FloatingPositionSchema.optional(),
  lastLoginHandle: z.string().optional(),
  lastSeenAppVersion: z.string().optional(),
  cachedProfile: AuthUserProfileSchema.nullable().optional(),
  docHibernateMinutes: z.number().int().min(3).max(120).default(15),
  developerMode: z.boolean().default(false),
  globalShortcut: z.string().default('CommandOrControl+Shift+K'),
  scheduledReminders: z.array(ScheduledReminderSchema).default([
    { id: 'builtin-morning', title: '开始今日专注', time: '09:00', enabled: true },
    { id: 'builtin-afternoon', title: '午后专注提醒', time: '13:30', enabled: true },
    { id: 'builtin-report', title: '记录今日进展与周报', time: '20:30', enabled: true },
  ]),
  windowBounds: WindowBoundsSchema.optional(),
});
export type OrbitConfig = z.infer<typeof OrbitConfigSchema>;

export const OrbitConfigPatchSchema = OrbitConfigSchema.partial().omit({ schemaVersion: true });
export type OrbitConfigPatch = z.infer<typeof OrbitConfigPatchSchema>;

export const AuthStateSchema = z.object({
  authenticated: z.boolean(),
  profile: AuthUserProfileSchema.nullable(),
  isStudioMember: z.boolean(),
  isAdmin: z.boolean(),
});
export type AuthState = z.infer<typeof AuthStateSchema>;

export const SignInStepResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('authenticated'),
    auth: AuthStateSchema,
  }),
  z.object({
    status: z.literal('mfa_required'),
    methods: z.array(z.enum(['totp', 'backup_code'])),
    message: z.string(),
  }),
  z.object({
    status: z.literal('error'),
    message: z.string(),
    canFallbackWeb: z.boolean().default(true),
  }),
]);
export type SignInStepResult = z.infer<typeof SignInStepResultSchema>;

export const PasswordSignInInputSchema = z.object({
  handle: z.string().trim().min(1, '请输入账号 Handle'),
  password: z.string().min(1, '请输入密码'),
});
export type PasswordSignInInput = z.infer<typeof PasswordSignInInputSchema>;

export const MfaVerifyInputSchema = z.object({
  method: z.enum(['totp', 'backup_code']),
  code: z.string().trim().min(4, '请输入验证码'),
});
export type MfaVerifyInput = z.infer<typeof MfaVerifyInputSchema>;

/** 外部浏览器 OAuth 登录选项：支持直达 GitHub / 飞书社交授权或注册页。 */
export const ExternalSignInOptionsSchema = z
  .object({
    provider: z.enum(['github', 'feishu']).optional(),
    firstScreen: z.enum(['sign_in', 'register']).optional(),
  })
  .optional();
export type ExternalSignInOptions = z.infer<typeof ExternalSignInOptionsSchema>;

export const UpdateAvatarUrlInputSchema = z.object({
  avatarUrl: z
    .string()
    .trim()
    .url('请输入有效的图片链接')
    .refine((v) => v.startsWith('https://') || v.startsWith('http://'), '仅支持 HTTP/HTTPS 图片链接')
    .nullable(),
});
export type UpdateAvatarUrlInput = z.infer<typeof UpdateAvatarUrlInputSchema>;

export const ChangePasswordInputSchema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码'),
  newPassword: z.string().min(8, '新密码长度至少 8 位'),
});
export type ChangePasswordInput = z.infer<typeof ChangePasswordInputSchema>;

export interface AccountActionResult {
  ok: boolean;
  cancelled?: boolean;
  auth?: AuthState;
  message?: string;
}

export interface SocialConnectionIdentity {
  userId: string;
  username: string | null;
  name: string | null;
  email: string | null;
  avatar: string | null;
  profileUrl: string | null;
}

export interface SocialConnectionItem {
  connectorId: string;
  target: string;
  name: string;
  linked: boolean;
  identity: SocialConnectionIdentity | null;
}

export interface SocialConnectionsResult {
  ok: boolean;
  items: SocialConnectionItem[];
  message?: string;
}

export interface StudioMemberSocialSummary {
  github: {
    username: string | null;
    name: string | null;
    avatar: string | null;
    profileUrl: string | null;
  } | null;
  feishu: {
    name: string | null;
    enName: string | null;
    avatar: string | null;
    linked: boolean;
  } | null;
}

export interface StudioMemberCard {
  id: string;
  username: string | null;
  name: string | null;
  avatar: string | null;
  enrollYear: number | null;
  roles: string[];
  social: StudioMemberSocialSummary;
}

export interface StudioMembersResult {
  ok: boolean;
  items: StudioMemberCard[];
  message?: string;
}

export const DocBoundsSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(0),
  height: z.number().int().min(0),
});
export type DocBounds = z.infer<typeof DocBoundsSchema>;

export interface DocPageContext {
  pageId?: string;
  pageSlug?: string;
  pageTitle?: string;
  canEdit?: boolean;
  spaceName?: string;
}

export interface DocEditRequestEvent {
  pageId?: string;
  pageSlug?: string;
  pageTitle?: string;
  reason?: string;
}

export interface DocViewState {
  active: boolean;
  mounted: boolean;
  hibernated: boolean;
  overlayHidden: boolean;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  hostMode?: 'dev' | 'bundled' | 'remote';
  pageContext?: DocPageContext | null;
}

export interface DocRecentItem {
  url: string;
  title: string;
  visitedAt: number;
}

export interface BlogViewState {
  active: boolean;
  mounted: boolean;
  hibernated: boolean;
  overlayHidden: boolean;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  loadError?: string | null;
}

export const INITIAL_BLOG_VIEW_STATE: BlogViewState = {
  active: false,
  mounted: false,
  hibernated: false,
  overlayHidden: false,
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  loadError: null,
};

export interface WeeklyDraftRecord {
  week: string;
  content: string;
  updatedAt: number;
}

export interface ApproveChallengeEvent {
  challengeId: string;
  receivedAt: number;
}

export interface OrbitChallengeDetail {
  challengeId: string;
  appName: string;
  clientHost?: string;
  confirmCode: string;
  requesterIp: string;
  riskLevel: 'normal' | 'high';
  status: 'pending' | 'approved' | 'denied' | 'consumed' | 'expired';
  expiresAt: number;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  releaseNotes?: string;
  changelog?: UpdateChangelog;
  publishedAt?: string;
  assetName?: string;
  assetUrl?: string;
  assetSize?: number;
  downloadedFilePath?: string;
  canAutoInstall?: boolean;
  errorMessage?: string;
  available: boolean;
  checked: boolean;
  stage?: 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'error';
  progressPercent?: number;
}

export interface TrayPunchSummary {
  checkedIn: boolean;
  elapsedSeconds: number;
  todaySeconds?: number;
  weekSeconds?: number;
  weekTargetSeconds?: number;
  networkAllowed?: boolean;
  authenticated?: boolean;
  statusLabel: string;
}

export interface ScannedWifiNetwork {
  bssid: string;
  ssid: string;
  rssi: number;
  seenCount: number;
  totalRounds: number;
  isLikelyHotspot: boolean;
}

export interface WifiScanOptions {
  /** 连续采样轮数（1~5，默认 1；队长采集工作室基线传 3）。 */
  samples?: number;
  /** 是否跳过 20s 缓存强制实时扫描。 */
  force?: boolean;
}

export interface WifiScanResult {
  ok: boolean;
  platform: NodeJS.Platform;
  scannedAt: number;
  rounds: number;
  networks: ScannedWifiNetwork[];
  error?: string;
  permissionDenied?: boolean;
}

export interface FloatingBallState extends TrayPunchSummary {
  expanded: boolean;
  theme: ThemePreference;
}

/** Preload 暴露给渲染进程的严格类型化桥接接口。 */
export interface OrbitBridge {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  auth: {
    getState: () => Promise<AuthState>;
    signInWithPassword: (input: PasswordSignInInput) => Promise<SignInStepResult>;
    verifyMfa: (input: MfaVerifyInput) => Promise<SignInStepResult>;
    signInWithEmbeddedWindow: (options?: ExternalSignInOptions) => Promise<SignInStepResult>;
    cancelExternalSignIn: () => Promise<void>;
    getApiToken: (target: 'punch' | 'orbit') => Promise<string | null>;
    pickAndUploadAvatar: () => Promise<AccountActionResult>;
    updateAvatarUrl: (input: UpdateAvatarUrlInput) => Promise<AccountActionResult>;
    changePassword: (input: ChangePasswordInput) => Promise<AccountActionResult>;
    getSocialConnections: () => Promise<SocialConnectionsResult>;
    listStudioMembers: () => Promise<StudioMembersResult>;
    signOut: () => Promise<AuthState>;
    onStateChanged: (listener: (state: AuthState) => void) => () => void;
  };
  doc: {
    activate: (bounds: DocBounds, url?: string) => Promise<DocViewState>;
    deactivate: () => Promise<void>;
    setBounds: (bounds: DocBounds) => Promise<void>;
    setOverlayVisible: (visible: boolean) => Promise<void>;
    navigate: (url: string) => Promise<void>;
    goBack: () => Promise<void>;
    goForward: () => Promise<void>;
    reload: () => Promise<void>;
    openExternal: () => Promise<void>;
    getState: () => Promise<DocViewState>;
    listRecents: (query?: string) => Promise<DocRecentItem[]>;
    onStateChanged: (listener: (state: DocViewState) => void) => () => void;
    onEditRequestTriggered: (listener: (payload: DocEditRequestEvent) => void) => () => void;
  };
  blog: {
    activate: (bounds: DocBounds, url?: string) => Promise<BlogViewState>;
    deactivate: () => Promise<void>;
    setBounds: (bounds: DocBounds) => Promise<void>;
    navigate: (url: string) => Promise<void>;
    goBack: () => Promise<void>;
    goForward: () => Promise<void>;
    reload: () => Promise<void>;
    openExternal: () => Promise<void>;
    getState: () => Promise<BlogViewState>;
    onStateChanged: (listener: (state: BlogViewState) => void) => () => void;
  };
  storage: {
    getCache: <T = unknown>(key: string) => Promise<{ value: T; updatedAt: number } | null>;
    setCache: (key: string, value: unknown) => Promise<void>;
    getWeeklyDraft: (week: string) => Promise<WeeklyDraftRecord | null>;
    saveWeeklyDraft: (week: string, content: string) => Promise<WeeklyDraftRecord>;
    clearUserCache: () => Promise<void>;
  };
  system: {
    getConfig: () => Promise<OrbitConfig>;
    updateConfig: (patch: OrbitConfigPatch) => Promise<OrbitConfig>;
    openExternal: (url: string) => Promise<void>;
    copyText: (text: string) => Promise<void>;
    notify: (title: string, body: string) => Promise<void>;
    updateTrayPunch: (summary: TrayPunchSummary) => Promise<void>;
    scanWifi: (options?: WifiScanOptions) => Promise<WifiScanResult>;
    openLocationSettings: () => Promise<boolean>;
    getUpdateState: () => Promise<UpdateCheckResult>;
    checkUpdate: () => Promise<UpdateCheckResult>;
    downloadUpdate: () => Promise<UpdateCheckResult>;
    installUpdate: () => Promise<void>;
    getVersionChangelog: (version?: string) => Promise<UpdateChangelog | null>;
    onUpdateStateChanged: (listener: (state: UpdateCheckResult) => void) => () => void;
    onCommandPaletteRequested: (listener: () => void) => () => void;
    onQuickPunchRequested: (listener: () => void) => () => void;
  };
  approve: {
    getChallenge: (challengeId: string) => Promise<OrbitChallengeDetail>;
    decide: (challengeId: string, action: 'approve' | 'deny') => Promise<OrbitChallengeDetail>;
    closeWindow: () => Promise<void>;
    onChallengeReceived: (listener: (event: ApproveChallengeEvent) => void) => () => void;
    promptBiometric: (reason: string) => Promise<boolean>;
  };
  floating: {
    getState: () => Promise<FloatingBallState>;
    setExpanded: (expanded: boolean) => Promise<void>;
    moveTo: (x: number, y: number) => Promise<void>;
    snapToEdge: () => Promise<void>;
    togglePunch: () => Promise<void>;
    openMain: () => Promise<void>;
    onStateChanged: (listener: (state: FloatingBallState) => void) => () => void;
  };
  hub: {
    listBuiltins: () => Promise<MiniAppBuiltinItem[]>;
    listInstalled: () => Promise<InstalledMiniAppRecord[]>;
    getRuntimeSnapshot: () => Promise<MiniAppRuntimeSnapshot>;
    launch: (input: MiniAppLaunchInput) => Promise<RunningMiniAppState>;
    launchLocalDir: (input: MiniAppLaunchLocalDirInput) => Promise<RunningMiniAppState>;
    launchDevUrl: (input: MiniAppLaunchDevUrlInput) => Promise<RunningMiniAppState>;
    switchMode: (appId: string, mode: MiniAppDisplayMode) => Promise<RunningMiniAppState | null>;
    close: (appId: string) => Promise<void>;
    reload: (appId: string) => Promise<void>;
    openDevTools: (appId: string) => Promise<void>;
    toggleFullscreen: (appId: string) => Promise<void>;
    setSidepanelBounds: (bounds: MiniAppBounds, width?: number) => Promise<void>;
    setWorkspaceBounds: (bounds: MiniAppBounds) => Promise<void>;
    uninstall: (appId: string) => Promise<void>;
    clearCache: () => Promise<{ freedBytes: number }>;
    pickLocalDir: () => Promise<{ ok: boolean; cancelled?: boolean; dirPath?: string; manifest?: OrbitAppManifest; error?: string }>;
    pickZipFile: () => Promise<{ ok: boolean; cancelled?: boolean; filePath?: string; fileName?: string; sizeBytes?: number; manifest?: OrbitAppManifest; error?: string }>;
    readZipFileBase64: (filePath: string) => Promise<{ base64: string; fileName: string; sizeBytes: number }>;
    getAppPref: (appId: string) => Promise<MiniAppUserPref>;
    setAppPref: (appId: string, patch: Partial<Omit<MiniAppUserPref, 'appId'>>) => Promise<MiniAppUserPref>;
    listAppPrefs: () => Promise<MiniAppUserPref[]>;
    onRuntimeChanged: (listener: (snapshot: MiniAppRuntimeSnapshot) => void) => () => void;
    onToastRequested: (listener: (payload: { appId: string; appName: string; message: string; tone?: 'info' | 'success' | 'warning' | 'error' }) => void) => () => void;
    dispatchRealtimeEvent: (payload: { appId: string; roomId?: string | null; event: string; payload?: unknown; ts?: number }) => Promise<void>;
  };
  schedule: {
    listSchedules: () => Promise<ScheduleSummary[]>;
    getDetail: (scheduleId?: string) => Promise<ScheduleDetail | null>;
    createSchedule: (input: CreateScheduleInput) => Promise<ScheduleSummary>;
    updateSchedule: (input: UpdateScheduleInput) => Promise<ScheduleSummary | null>;
    setActiveSchedule: (scheduleId: string) => Promise<boolean>;
    deleteSchedule: (scheduleId: string) => Promise<void>;
    clearCourses: (scheduleId: string) => Promise<void>;
    upsertCourse: (input: UpsertCourseInput) => Promise<ScheduleCourseWithMeetings>;
    deleteCourses: (scheduleId: string, courseIds: string[]) => Promise<void>;
    listTimetables: () => Promise<ScheduleTimetable[]>;
    saveTimetable: (input: SaveTimetableInput) => Promise<ScheduleTimetable>;
    getImportState: () => Promise<SwpuImportWindowState>;
    openSwpuImport: (options?: {
      networkMode?: SwpuNetworkMode;
      clearSession?: boolean;
    }) => Promise<SwpuImportWindowState>;
    fetchSwpuSchedule: (termCode?: string) => Promise<SwpuImportWindowState>;
    closeSwpuImport: () => Promise<SwpuImportWindowState>;
    applySwpuImport: (input: ApplySwpuImportInput) => Promise<ScheduleDetail>;
    exportIcs: (scheduleId: string) => Promise<{ ok: boolean; cancelled?: boolean; filePath?: string; message?: string }>;
    exportShareJson: (scheduleId: string) => Promise<{ ok: boolean; json?: string; message?: string }>;
    importShareJson: (rawJson: string) => Promise<{ ok: boolean; detail?: ScheduleDetail; message?: string }>;
    onImportStateChanged: (listener: (state: SwpuImportWindowState) => void) => () => void;
  };
  calendar: {
    getSnapshot: () => Promise<CalendarSnapshot>;
    saveCategory: (input: SaveCalendarCategoryInput) => Promise<CalendarCategory>;
    setCategoryVisible: (categoryId: string, visible: boolean) => Promise<void>;
    deleteCategory: (categoryId: string) => Promise<void>;
    upsertEvent: (input: UpsertCalendarEventInput) => Promise<CalendarEvent>;
    deleteEvent: (eventId: string) => Promise<void>;
    upsertTask: (input: UpsertCalendarTaskInput) => Promise<CalendarTask>;
    toggleTask: (taskId: string, completed: boolean) => Promise<CalendarTask | null>;
    deleteTask: (taskId: string) => Promise<void>;
    saveSubscription: (
      input: SaveCalendarSubscriptionInput,
    ) => Promise<{ subscription: CalendarSubscription; itemCount: number; warning?: string }>;
    refreshSubscription: (
      subscriptionId: string,
    ) => Promise<{ subscription: CalendarSubscription; itemCount: number; warning?: string }>;
    setSubscriptionVisible: (subscriptionId: string, visible: boolean) => Promise<void>;
    deleteSubscription: (subscriptionId: string) => Promise<void>;
    importIcsFile: (input?: ImportIcsFileInput) => Promise<ImportIcsFileResult>;
  };
}
