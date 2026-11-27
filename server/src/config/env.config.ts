/**
 * 统一服务端环境变量配置与校验。
 * 保持与原 Orbit Go 服务端所有环境变量名 100% 兼容，同时新增 Economy 底层风控配置。
 */
import { z } from 'zod';

const envStr = (fallback = '') =>
  z
    .string()
    .optional()
    .transform((v) => {
      const trimmed = (v ?? '').trim();
      return trimmed !== '' ? trimmed : fallback;
    });

const envInt = (fallback: number, min = 0, max = 100_000) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (!v || !v.trim()) return fallback;
      const n = Number.parseInt(v.trim(), 10);
      if (!Number.isFinite(n) || n < min || n > max) return fallback;
      return n;
    });

const envBool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (!v || !v.trim()) return fallback;
      const lower = v.trim().toLowerCase();
      if (lower === 'true' || lower === '1' || lower === 'yes') return true;
      if (lower === 'false' || lower === '0' || lower === 'no') return false;
      return fallback;
    });

const RawEnvSchema = z.object({
  PORT: envInt(8080, 1, 65535),
  NODE_ENV: envStr('development'),

  DATABASE_URL: envStr(''),
  DB_SYNCHRONIZE: envBool(false),
  DB_RUN_MIGRATIONS: envBool(true),
  REDIS_URL: envStr(''),

  LEC_SSO_ENDPOINT: envStr('https://sso.lecspace.top'),
  LEC_SSO_ISSUER: envStr(''),
  LEC_SSO_ORG_ID: envStr('lec-studio'),
  LEC_SSO_M2M_CLIENT_ID: envStr(''),
  LEC_SSO_M2M_CLIENT_SECRET: envStr(''),
  LEC_SSO_M2M_RESOURCE: envStr('https://default.logto.app/api'),
  LEC_ORBIT_API_RESOURCE: envStr(''),

  ORBIT_INTERNAL_TOKEN: envStr(''),
  LEC_DOC_INTERNAL_URL: envStr('http://lec-doc.lec-doc-production.svc.cluster.local:3000'),
  LEC_DOC_INTERNAL_TOKEN: envStr(''),
  LEC_DOC_PUBLIC_URL: envStr('https://doc.lecspace.top'),

  LEC_S3_ENDPOINT: envStr(''),
  LEC_S3_BUCKET: envStr('lec-public'),
  LEC_S3_REGION: envStr('us-east-1'),
  LEC_S3_ACCESS_KEY: envStr(''),
  LEC_S3_SECRET_KEY: envStr(''),
  LEC_S3_PUBLIC_URL: envStr('https://drive.lecspace.top/orbit'),
  LEC_S3_KEY_PREFIX: envStr('orbit'),

  // LecPunch 私有对象存储（卡牌立绘 + 举报附件图）与局域网会议签名配置
  PUNCH_S3_ENDPOINT: envStr(''),
  PUNCH_S3_BUCKET: envStr('lec-private'),
  PUNCH_S3_REGION: envStr('us-east-1'),
  PUNCH_S3_ACCESS_KEY: envStr(''),
  PUNCH_S3_SECRET_KEY: envStr(''),
  PUNCH_S3_CARD_ASSETS_PREFIX: envStr('punch/cards/20261027-v1'),
  PUNCH_S3_REPORT_IMAGES_PREFIX: envStr('punch/reports'),
  REPORT_IMAGE_RETENTION_HOURS: envInt(3, 1, 168),
  ASSESSMENT_START_WEEK: envStr(''),
  MEET_JWT_APP_ID: envStr(''),
  MEET_JWT_SECRET: envStr(''),

  GITHUB_TOKEN: envStr(''),
  ORBIT_GITHUB_REPO: envStr('lec-org/lec-orbit'),

  // Nakama 游戏联机 BaaS 接入配置（内网换票 + 公网 SDK 连接端点）
  NAKAMA_INTERNAL_URL: envStr('http://nakama.lec-orbit-production.svc.cluster.local:7350'),
  NAKAMA_PUBLIC_HOST: envStr('orbit.lecspace.top'),
  NAKAMA_PUBLIC_PORT: envStr('443'),
  NAKAMA_PUBLIC_USE_SSL: envBool(true),
  NAKAMA_SERVER_KEY: envStr(''),
  NAKAMA_HTTP_KEY: envStr(''),

  // Orbit 托管云函数 FaaS（内网 supabase/edge-runtime 集群服务地址）
  EDGE_RUNTIME_URL: envStr(''),

  // Economy（coin 乐币与 punch_minutes 打卡时长交易底层配置）
  ECONOMY_CREDENTIAL_MASTER_KEY: envStr(''),
  ECONOMY_PUNCH_AFFECTS_ASSESSMENT: envBool(true),
  ECONOMY_BURN_RATE_BPS: envInt(0, 0, 2000), // 万分比燃烧税（0~20%，默认 0）
  ECONOMY_MAX_COIN_PER_ORDER: envInt(50, 1, 5000),
  ECONOMY_MAX_PUNCH_PER_ORDER: envInt(30, 1, 120),
  ECONOMY_DAILY_COIN_NET_LIMIT: envInt(200, 10, 10000),
  ECONOMY_WEEKLY_COIN_GAIN_LIMIT: envInt(500, 10, 50000),
  ECONOMY_WEEKLY_PUNCH_GAIN_LIMIT: envInt(60, 10, 300),
  ECONOMY_WEEKLY_PUNCH_LOSS_LIMIT: envInt(60, 10, 300),
  ECONOMY_DAILY_COIN_SAME_OPPONENT_LIMIT: envInt(5, 1, 50),
  ECONOMY_WEEKLY_PUNCH_SAME_OPPONENT_LIMIT: envInt(2, 1, 20),
  ECONOMY_PUNCH_MIN_RECORDED_MINUTES: envInt(60, 0, 600),
  ECONOMY_MAX_ACTIVE_ORDERS_PER_USER: envInt(3, 1, 20),
  ECONOMY_DEFAULT_ACCEPT_TTL_SECONDS: envInt(1800, 60, 7200),
  ECONOMY_DEFAULT_SETTLE_TTL_SECONDS: envInt(14400, 300, 43200),
});

export interface AppConfig {
  port: number;
  nodeEnv: string;
  databaseUrl: string;
  dbSynchronize: boolean;
  dbRunMigrations: boolean;
  redisUrl: string;

  ssoEndpoint: string;
  ssoIssuer: string;
  ssoOrgId: string;
  ssoM2mClientId: string;
  ssoM2mClientSecret: string;
  ssoM2mResource: string;
  orbitApiResource: string;

  internalServiceToken: string;
  lecDocInternalUrl: string;
  lecDocInternalToken: string;
  lecDocPublicUrl: string;

  s3Endpoint: string;
  s3Bucket: string;
  s3Region: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3PublicBaseUrl: string;
  s3KeyPrefix: string;

  punchStorage: {
    endpoint: string;
    bucket: string;
    region: string;
    accessKey: string;
    secretKey: string;
    cardAssetsPrefix: string;
    reportImagesPrefix: string;
    reportImageRetentionHours: number;
  };
  meetJwtAppId: string;
  meetJwtSecret: string;
  assessmentStartWeek: string;

  githubToken: string;
  orbitGithubRepo: string;

  nakama: {
    internalUrl: string;
    publicHost: string;
    publicPort: string;
    publicUseSsl: boolean;
    serverKey: string;
    httpKey: string;
  };

  edgeRuntimeUrl: string;

  economy: {
    credentialMasterKey: string;
    punchAffectsAssessment: boolean;
    burnRateBps: number;
    maxCoinPerOrder: number;
    maxPunchPerOrder: number;
    dailyCoinNetLimit: number;
    weeklyCoinGainLimit: number;
    weeklyPunchGainLimit: number;
    weeklyPunchLossLimit: number;
    dailyCoinSameOpponentLimit: number;
    weeklyPunchSameOpponentLimit: number;
    punchMinRecordedMinutes: number;
    maxActiveOrdersPerUser: number;
    defaultAcceptTtlSeconds: number;
    defaultSettleTtlSeconds: number;
  };
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = RawEnvSchema.parse(env);
  const ssoEndpoint = parsed.LEC_SSO_ENDPOINT.replace(/\/+$/, '');
  const ssoIssuer = (parsed.LEC_SSO_ISSUER || `${ssoEndpoint}/oidc`).replace(/\/+$/, '');

  return {
    port: parsed.PORT,
    nodeEnv: parsed.NODE_ENV,
    databaseUrl: parsed.DATABASE_URL,
    dbSynchronize: parsed.DB_SYNCHRONIZE,
    dbRunMigrations: parsed.DB_RUN_MIGRATIONS,
    redisUrl: parsed.REDIS_URL,

    ssoEndpoint,
    ssoIssuer,
    ssoOrgId: parsed.LEC_SSO_ORG_ID,
    ssoM2mClientId: parsed.LEC_SSO_M2M_CLIENT_ID,
    ssoM2mClientSecret: parsed.LEC_SSO_M2M_CLIENT_SECRET,
    ssoM2mResource: parsed.LEC_SSO_M2M_RESOURCE,
    orbitApiResource: parsed.LEC_ORBIT_API_RESOURCE,

    internalServiceToken: parsed.ORBIT_INTERNAL_TOKEN,
    lecDocInternalUrl: parsed.LEC_DOC_INTERNAL_URL.replace(/\/+$/, ''),
    lecDocInternalToken: parsed.LEC_DOC_INTERNAL_TOKEN,
    lecDocPublicUrl: parsed.LEC_DOC_PUBLIC_URL.replace(/\/+$/, ''),

    s3Endpoint: parsed.LEC_S3_ENDPOINT.replace(/\/+$/, ''),
    s3Bucket: parsed.LEC_S3_BUCKET,
    s3Region: parsed.LEC_S3_REGION,
    s3AccessKey: parsed.LEC_S3_ACCESS_KEY,
    s3SecretKey: parsed.LEC_S3_SECRET_KEY,
    s3PublicBaseUrl: parsed.LEC_S3_PUBLIC_URL.replace(/\/+$/, ''),
    s3KeyPrefix: parsed.LEC_S3_KEY_PREFIX.replace(/^\/+|\/+$/g, ''),

    punchStorage: {
      endpoint: (parsed.PUNCH_S3_ENDPOINT || parsed.LEC_S3_ENDPOINT).replace(/\/+$/, ''),
      bucket: parsed.PUNCH_S3_BUCKET,
      region: parsed.PUNCH_S3_REGION || parsed.LEC_S3_REGION,
      accessKey: parsed.PUNCH_S3_ACCESS_KEY,
      secretKey: parsed.PUNCH_S3_SECRET_KEY,
      cardAssetsPrefix: parsed.PUNCH_S3_CARD_ASSETS_PREFIX.replace(/^\/+|\/+$/g, ''),
      reportImagesPrefix: parsed.PUNCH_S3_REPORT_IMAGES_PREFIX.replace(/^\/+|\/+$/g, ''),
      reportImageRetentionHours: parsed.REPORT_IMAGE_RETENTION_HOURS,
    },
    meetJwtAppId: parsed.MEET_JWT_APP_ID,
    meetJwtSecret: parsed.MEET_JWT_SECRET,
    assessmentStartWeek: parsed.ASSESSMENT_START_WEEK,

    githubToken: parsed.GITHUB_TOKEN,
    orbitGithubRepo: parsed.ORBIT_GITHUB_REPO,

    nakama: {
      internalUrl: parsed.NAKAMA_INTERNAL_URL.replace(/\/+$/, ''),
      publicHost: parsed.NAKAMA_PUBLIC_HOST,
      publicPort: parsed.NAKAMA_PUBLIC_PORT,
      publicUseSsl: parsed.NAKAMA_PUBLIC_USE_SSL,
      serverKey: parsed.NAKAMA_SERVER_KEY,
      httpKey: parsed.NAKAMA_HTTP_KEY,
    },

    edgeRuntimeUrl: parsed.EDGE_RUNTIME_URL.replace(/\/+$/, ''),

    economy: {
      credentialMasterKey: parsed.ECONOMY_CREDENTIAL_MASTER_KEY || parsed.ORBIT_INTERNAL_TOKEN,
      punchAffectsAssessment: parsed.ECONOMY_PUNCH_AFFECTS_ASSESSMENT,
      burnRateBps: parsed.ECONOMY_BURN_RATE_BPS,
      maxCoinPerOrder: parsed.ECONOMY_MAX_COIN_PER_ORDER,
      maxPunchPerOrder: parsed.ECONOMY_MAX_PUNCH_PER_ORDER,
      dailyCoinNetLimit: parsed.ECONOMY_DAILY_COIN_NET_LIMIT,
      weeklyCoinGainLimit: parsed.ECONOMY_WEEKLY_COIN_GAIN_LIMIT,
      weeklyPunchGainLimit: parsed.ECONOMY_WEEKLY_PUNCH_GAIN_LIMIT,
      weeklyPunchLossLimit: parsed.ECONOMY_WEEKLY_PUNCH_LOSS_LIMIT,
      dailyCoinSameOpponentLimit: parsed.ECONOMY_DAILY_COIN_SAME_OPPONENT_LIMIT,
      weeklyPunchSameOpponentLimit: parsed.ECONOMY_WEEKLY_PUNCH_SAME_OPPONENT_LIMIT,
      punchMinRecordedMinutes: parsed.ECONOMY_PUNCH_MIN_RECORDED_MINUTES,
      maxActiveOrdersPerUser: parsed.ECONOMY_MAX_ACTIVE_ORDERS_PER_USER,
      defaultAcceptTtlSeconds: parsed.ECONOMY_DEFAULT_ACCEPT_TTL_SECONDS,
      defaultSettleTtlSeconds: parsed.ECONOMY_DEFAULT_SETTLE_TTL_SECONDS,
    },
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
