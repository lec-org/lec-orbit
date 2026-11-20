import { z } from 'zod';

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
  floatingBallEnabled: z.boolean().default(true),
  floatingBallPosition: FloatingPositionSchema.optional(),
  lastLoginHandle: z.string().optional(),
  cachedProfile: AuthUserProfileSchema.nullable().optional(),
  docHibernateMinutes: z.number().int().min(3).max(120).default(15),
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
    signInWithEmbeddedWindow: () => Promise<SignInStepResult>;
    getApiToken: (target: 'punch' | 'orbit') => Promise<string | null>;
    pickAndUploadAvatar: () => Promise<AccountActionResult>;
    updateAvatarUrl: (input: UpdateAvatarUrlInput) => Promise<AccountActionResult>;
    changePassword: (input: ChangePasswordInput) => Promise<AccountActionResult>;
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
    getUpdateState: () => Promise<UpdateCheckResult>;
    checkUpdate: () => Promise<UpdateCheckResult>;
    downloadUpdate: () => Promise<UpdateCheckResult>;
    installUpdate: () => Promise<void>;
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
}
