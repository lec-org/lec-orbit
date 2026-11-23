/** Orbit 工坊（小程序 + 小游戏容器）共享协议、Manifest 校验与运行态类型定义。 */
import { z } from 'zod';

export const MiniAppTypeSchema = z.enum(['miniapp', 'minigame']);
export type MiniAppType = z.infer<typeof MiniAppTypeSchema>;

export const MiniAppEngineSchema = z.enum(['web', 'cocos', 'unity', 'godot', 'other']);
export type MiniAppEngine = z.infer<typeof MiniAppEngineSchema>;

export const MiniAppDisplayModeSchema = z.enum(['sidepanel', 'workspace', 'standalone']);
export type MiniAppDisplayMode = z.infer<typeof MiniAppDisplayModeSchema>;

export const MiniAppIsolationPolicySchema = z.enum(['credentialless', 'require-corp']);
export type MiniAppIsolationPolicy = z.infer<typeof MiniAppIsolationPolicySchema>;

export const MiniAppPermissionScopeSchema = z.enum([
  'user.profile',
  'storage.cloud',
  'clipboard',
]);
export type MiniAppPermissionScope = z.infer<typeof MiniAppPermissionScopeSchema>;

export const MiniAppIdSchema = z
  .string()
  .trim()
  .min(2, '应用 ID 至少 2 个字符')
  .max(64, '应用 ID 最长 64 个字符')
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, '应用 ID 仅允许小写字母、数字与短横线');

export const MiniAppWindowConfigSchema = z
  .object({
    defaultMode: MiniAppDisplayModeSchema.default('workspace'),
    supportedModes: z
      .array(MiniAppDisplayModeSchema)
      .min(1)
      .default(['sidepanel', 'workspace', 'standalone']),
    sidepanelWidth: z.number().int().min(320).max(640).default(400),
    width: z.number().int().min(360).max(2560).default(1120),
    height: z.number().int().min(480).max(1600).default(720),
    resizable: z.boolean().default(true),
    aspectRatio: z.string().max(16).optional(),
    allowFullscreen: z.boolean().default(true),
  })
  .default({
    defaultMode: 'workspace',
    supportedModes: ['sidepanel', 'workspace', 'standalone'],
    sidepanelWidth: 400,
    width: 1120,
    height: 720,
    resizable: true,
    allowFullscreen: true,
  });

export const MiniAppRuntimeConfigSchema = z
  .object({
    /** 是否启用 COOP/COEP 跨源隔离以支持 SharedArrayBuffer（Godot 4 多线程 / Unity Threads 必需）。 */
    crossOriginIsolated: z.boolean().default(false),
    isolationPolicy: MiniAppIsolationPolicySchema.default('credentialless'),
    pointerLock: z.boolean().default(false),
    gamepad: z.boolean().default(true),
    minOrbitVersion: z.string().max(32).optional(),
  })
  .default({
    crossOriginIsolated: false,
    isolationPolicy: 'credentialless',
    pointerLock: false,
    gamepad: true,
  });

export const MiniAppPermissionsSchema = z
  .object({
    scopes: z.array(MiniAppPermissionScopeSchema).default(['user.profile', 'storage.cloud']),
    networkDomains: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(128)
          .refine((d) => !d.includes(' ') && !d.includes(';'), '域名格式非法'),
      )
      .max(16)
      .default([]),
  })
  .default({
    scopes: ['user.profile', 'storage.cloud'],
    networkDomains: [],
  });

export const OrbitAppManifestSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: MiniAppIdSchema,
  name: z.string().trim().min(1, '应用名称不能为空').max(48, '应用名称最长 48 字'),
  version: z
    .string()
    .trim()
    .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, '版本号需符合 SemVer（如 1.0.0）'),
  type: MiniAppTypeSchema.default('miniapp'),
  engine: MiniAppEngineSchema.default('web'),
  entry: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((v) => !v.startsWith('/') && !v.includes('..'), '入口路径不能包含绝对路径或 ..')
    .default('index.html'),
  icon: z
    .string()
    .trim()
    .max(200)
    .refine((v) => !v.startsWith('/') && !v.includes('..'), '图标路径非法')
    .optional(),
  description: z.string().trim().max(400).default(''),
  tags: z.array(z.string().trim().min(1).max(24)).max(8).default([]),
  window: MiniAppWindowConfigSchema,
  runtime: MiniAppRuntimeConfigSchema,
  permissions: MiniAppPermissionsSchema,
});
export type OrbitAppManifest = z.infer<typeof OrbitAppManifestSchema>;

export type MiniAppLaunchSource = 'builtin' | 'installed' | 'local-dir' | 'dev-url';

export interface RunningMiniAppState {
  appId: string;
  name: string;
  type: MiniAppType;
  engine: MiniAppEngine;
  version: string;
  mode: MiniAppDisplayMode;
  supportedModes: MiniAppDisplayMode[];
  sidepanelWidth: number;
  source: MiniAppLaunchSource;
  crossOriginIsolated: boolean;
  loading: boolean;
  error?: string;
  overlayHidden: boolean;
  iconUrl?: string;
  devUrl?: string;
  localDir?: string;
}

export interface MiniAppRuntimeSnapshot {
  apps: RunningMiniAppState[];
}

export interface MiniAppUserPref {
  appId: string;
  preferredMode?: MiniAppDisplayMode;
  sidepanelWidth?: number;
  pinned?: boolean;
  grantedScopes?: MiniAppPermissionScope[];
  lastOpenedAt?: number;
}

export interface InstalledMiniAppRecord {
  appId: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  installDir: string;
  manifest: OrbitAppManifest;
  installedAt: number;
  lastOpenedAt: number;
}

export interface MiniAppBuiltinItem {
  appId: string;
  manifest: OrbitAppManifest;
  dirPath: string;
  badgeText?: string;
}

export interface MiniAppBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MiniAppBoundsSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(0),
  height: z.number().int().min(0),
});

export interface MiniAppLaunchInput {
  appId: string;
  mode?: MiniAppDisplayMode;
  /** 若需先下载并缓存线上包，传入最新版本信息。 */
  remoteBundle?: {
    version: string;
    bundleUrl: string;
    bundleSha256: string;
    bundleSize?: number;
    manifest?: OrbitAppManifest;
    iconUrl?: string;
  };
}

export interface MiniAppLaunchLocalDirInput {
  dirPath: string;
  mode?: MiniAppDisplayMode;
}

export interface MiniAppLaunchDevUrlInput {
  appId: string;
  name: string;
  url: string;
  type?: MiniAppType;
  engine?: MiniAppEngine;
  mode?: MiniAppDisplayMode;
  crossOriginIsolated?: boolean;
}

/** 服务端工坊接口 DTO（与 lec-orbit-server JSON 结构一致）。 */
export interface MiniAppVersionItem {
  id: string;
  appId: string;
  version: string;
  channel: 'preview' | 'release';
  status: 'pending' | 'approved' | 'rejected' | 'rolled_back';
  sourceType: 'rustfs' | 'github';
  bundleUrl: string;
  bundleSha256: string;
  bundleSize: number;
  manifest: OrbitAppManifest;
  changelog: string;
  uploaderId: string;
  reviewerId?: string;
  reviewNote?: string;
  createdAt: string;
  reviewedAt?: string;
}

export interface MiniAppCatalogItem {
  id: string;
  name: string;
  type: MiniAppType;
  engine: MiniAppEngine;
  description: string;
  iconUrl: string;
  tags: string[];
  ownerId: string;
  ownerName: string;
  ownerAvatar: string;
  status: 'draft' | 'published' | 'suspended';
  featuredRank: number;
  playCount: number;
  activeVersion?: MiniAppVersionItem | null;
  latestVersion?: MiniAppVersionItem | null;
  createdAt: string;
  updatedAt: string;
}

export interface MiniAppDetail extends MiniAppCatalogItem {
  versions: MiniAppVersionItem[];
}

export const MINIAPP_MAX_BUNDLE_BYTES = 100 * 1024 * 1024; // 100MB 默认单包上限
export const MINIAPP_MAX_UNCOMPRESSED_BYTES = 250 * 1024 * 1024; // 250MB 防 Zip Bomb 上限
export const MINIAPP_MAX_FILE_COUNT = 5000;

export function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function engineDisplayLabel(engine: MiniAppEngine): string {
  switch (engine) {
    case 'cocos':
      return 'Cocos';
    case 'unity':
      return 'Unity';
    case 'godot':
      return 'Godot';
    case 'web':
      return 'Web';
    default:
      return '其他';
  }
}

export function modeDisplayLabel(mode: MiniAppDisplayMode): string {
  switch (mode) {
    case 'sidepanel':
      return '右侧伴随栏';
    case 'workspace':
      return '主区全幅';
    case 'standalone':
      return '独立窗口';
  }
}
