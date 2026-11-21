/** LecPunch 后端接口统一 Axios 客户端：集中维护接口路径、鉴权拦截与响应适配。 */
import axios, { AxiosError } from 'axios';
import { getOrbitEndpoints } from '@shared/env';
import {
  formatMemberDisplayName,
  type AttendanceRecordItem,
  type AttendanceSnapshot,
  type CardGameActionInput,
  type CardGameActionResponse,
  type CardGameView,
  type MemberTitleBadge,
  type MyTitlesView,
  type MyWeeklyStats,
  type NetworkPolicyStatus,
  type PointsSummary,
  type PunchNotificationItem,
  type PunchUser,
  type TeamActiveMember,
  type TeamEventItem,
  type TeamWeeklyRankingItem,
  type UpdateWifiFingerprintInput,
  type WeeklyReportItem,
  type WifiFingerprintConfig,
} from '@shared/punch';
import { getOrbitClient } from './orbitClient';

export class PunchApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PunchApiError';
  }
}

function normalizePunchError(err: unknown): PunchApiError {
  if (err instanceof PunchApiError) return err;
  if (err instanceof AxiosError) {
    const status = err.response?.status;
    const payload = err.response?.data as { message?: unknown; error?: unknown } | undefined;
    const serverMsg =
      typeof payload?.message === 'string'
        ? payload.message
        : Array.isArray(payload?.message)
          ? payload.message.join('；')
          : undefined;
    if (status === 401) {
      return new PunchApiError(serverMsg || '登录凭证已失效，请重新登录 LecSSO。', 401);
    }
    if (status === 403) {
      return new PunchApiError(serverMsg || '当前账号或所在网络无权执行该操作。', 403);
    }
    if (status === 404) {
      return new PunchApiError(serverMsg || '请求的考勤接口或记录不存在。', 404);
    }
    if (status && status >= 500) {
      return new PunchApiError(serverMsg || `LecPunch 服务暂时不可用（HTTP ${status}）。`, status);
    }
    if (err.code === 'ECONNABORTED') {
      return new PunchApiError('请求超时，请检查当前校园网络连接。');
    }
    if (!err.response) {
      return new PunchApiError('无法连接 LecPunch 服务，请检查网络状态。');
    }
    return new PunchApiError(serverMsg || `请求失败（HTTP ${status ?? '未知'}）。`, status);
  }
  return new PunchApiError(err instanceof Error ? err.message : '请求 LecPunch 服务失败。');
}

/** 集中定义的 LecPunch 接口路径表。 */
export const PUNCH_ENDPOINTS = {
  me: '/auth/me',
  attendanceCurrent: '/attendance/current',
  checkIn: '/attendance/check-in',
  checkOut: '/attendance/check-out',
  teamActive: '/attendance/team-active',
  networkStatus: '/network-policy/current-status',
  adminWifiFingerprint: '/network-policy/admin/wifi-fingerprint',
  myWeeklyStats: '/stats/me/weekly',
  teamWeeklyStats: '/stats/team/current-week',
  myRecords: '/records/me',
  myPoints: '/points/me',
  myWeeklyReport: '/weekly-reports/me',
  teamEvents: '/team-events/events',
  notifications: '/notifications/me',
  ackNotification: (id: string) => `/notifications/${encodeURIComponent(id)}/ack`,
  titlesMe: '/titles/me',
  titlesEquip: '/titles/me/equip',
  cardsMe: '/cards/me',
  cardsActions: '/cards/actions',
  cardsGiftsAck: '/cards/gifts/ack',
  cardsDefensesAck: '/cards/defenses/ack',
  cardsInteractionsAck: '/cards/interactions/ack',
  cardsArt: (cardId: string) => `/cards/art/${encodeURIComponent(cardId)}`,
} as const;

const cardArtUrlCache = new Map<string, string>();
const cardArtInFlight = new Map<string, Promise<string>>();
const CARD_ART_CACHE_NAME = 'orbit-card-art-v1';

async function readCardArtFromDiskCache(cardId: string): Promise<Blob | null> {
  if (typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(CARD_ART_CACHE_NAME);
    const res = await cache.match(`https://orbit-cache.local/cards/art/${encodeURIComponent(cardId)}`);
    if (!res || !res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

async function writeCardArtToDiskCache(cardId: string, blob: Blob): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(CARD_ART_CACHE_NAME);
    await cache.put(
      `https://orbit-cache.local/cards/art/${encodeURIComponent(cardId)}`,
      new Response(blob, { headers: { 'Content-Type': blob.type || 'image/png' } }),
    );
  } catch {
    // 忽略磁盘缓存写入失败
  }
}

const client = axios.create({
  baseURL: getOrbitEndpoints().punchApiBase,
  timeout: 15_000,
  headers: { Accept: 'application/json' },
});

client.interceptors.request.use(async (config) => {
  const token = await getOrbitClient().auth.getApiToken('punch');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

client.interceptors.response.use(
  (response) => response,
  (error: unknown) => Promise.reject(normalizePunchError(error)),
);

function unwrapArray<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object' && key in data) {
    const value = (data as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value as T[];
  }
  return [];
}

function normalizeTitleBadges(raw: unknown): MemberTitleBadge[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .filter((item) => typeof item.id === 'string' && typeof item.name === 'string')
    .map((item) => ({
      id: String(item.id),
      name: String(item.name),
      description: typeof item.description === 'string' ? item.description : '',
      proposer: typeof item.proposer === 'string' ? item.proposer : 'LEC',
      category: (item.category as MemberTitleBadge['category']) ?? 'honor',
      forced: Boolean(item.forced),
      icon: (item.icon as MemberTitleBadge['icon']) ?? 'crown',
      theme: (item.theme as MemberTitleBadge['theme']) ?? 'amber',
    }));
}

interface WifiScanPayloadSample {
  bssid: string;
  ssid?: string;
  rssi?: number;
}

async function collectWifiScanForApi(force: boolean): Promise<{
  samples: WifiScanPayloadSample[];
  error?: string;
}> {
  try {
    const res = await getOrbitClient().system.scanWifi({ samples: 1, force });
    const samples: WifiScanPayloadSample[] = (res.networks ?? [])
      .slice(0, 120)
      .map((item) => ({
        bssid: item.bssid,
        ...(item.ssid ? { ssid: item.ssid.slice(0, 64) } : {}),
        rssi: item.rssi,
      }));
    return {
      samples,
      error: res.ok ? undefined : res.error,
    };
  } catch (err) {
    return {
      samples: [],
      error: err instanceof Error ? err.message : '读取周边 Wi-Fi 信号失败。',
    };
  }
}

export const punchApi = {
  async fetchCurrentUser(): Promise<PunchUser> {
    const { data } = await client.get<PunchUser>(PUNCH_ENDPOINTS.me);
    return data;
  },

  async fetchAttendance(): Promise<AttendanceSnapshot> {
    const { data } = await client.get<{
      hasActiveSession?: boolean;
      session?: {
        id?: string;
        checkInAt?: string;
        elapsedSeconds?: number;
        durationSeconds?: number;
        creditedSeconds?: number;
      } | null;
      isCheckedIn?: boolean;
      checkedInAt?: string | null;
      activeSessionId?: string | null;
      todayDurationSeconds?: number;
      currentSessionSeconds?: number;
      weekDurationSeconds?: number;
      weekTargetSeconds?: number;
    }>(PUNCH_ENDPOINTS.attendanceCurrent);

    const session = data.session ?? null;
    const isCheckedIn = Boolean(data.hasActiveSession ?? data.isCheckedIn ?? session);
    return {
      isCheckedIn,
      checkedInAt: session?.checkInAt ?? data.checkedInAt ?? null,
      activeSessionId: session?.id ?? data.activeSessionId ?? null,
      todayDurationSeconds: Number(data.todayDurationSeconds ?? 0),
      currentSessionSeconds: Number(
        session?.elapsedSeconds ?? session?.creditedSeconds ?? data.currentSessionSeconds ?? 0,
      ),
      weekDurationSeconds: Number(data.weekDurationSeconds ?? 0),
      weekTargetSeconds: Number(data.weekTargetSeconds ?? 18 * 3600),
    };
  },

  async checkIn(): Promise<AttendanceSnapshot> {
    const scan = await collectWifiScanForApi(true);
    try {
      await client.post(
        PUNCH_ENDPOINTS.checkIn,
        scan.samples.length > 0 ? { wifiScan: scan.samples } : {},
      );
    } catch (err) {
      if (err instanceof PunchApiError && err.status === 403 && scan.samples.length === 0 && scan.error) {
        throw new PunchApiError(`${err.message}（${scan.error}）`, 403);
      }
      throw err;
    }
    return this.fetchAttendance();
  },

  async checkOut(): Promise<AttendanceSnapshot> {
    const scan = await collectWifiScanForApi(true);
    try {
      await client.post(
        PUNCH_ENDPOINTS.checkOut,
        scan.samples.length > 0 ? { wifiScan: scan.samples } : {},
      );
    } catch (err) {
      if (err instanceof PunchApiError && err.status === 403 && scan.samples.length === 0 && scan.error) {
        throw new PunchApiError(`${err.message}（${scan.error}）`, 403);
      }
      throw err;
    }
    return this.fetchAttendance();
  },

  async fetchNetworkStatus(forceWifiScan = false): Promise<NetworkPolicyStatus> {
    const scan = await collectWifiScanForApi(forceWifiScan);
    try {
      const { data } = await client.post<{
        isAllowed?: boolean;
        allowed?: boolean;
        ipAllowed?: boolean;
        clientIp?: string;
        reason?: string;
        wifiFingerprintEnabled?: boolean;
        wifiAllowed?: boolean;
        matchedCount?: number;
        requiredMatchCount?: number;
        configuredAnchorCount?: number;
      }>(
        PUNCH_ENDPOINTS.networkStatus,
        scan.samples.length > 0 ? { wifiScan: scan.samples } : {},
      );
      const allowed = Boolean(data.isAllowed ?? data.allowed);
      const wifiFingerprintEnabled = Boolean(data.wifiFingerprintEnabled);
      const wifiAllowed =
        typeof data.wifiAllowed === 'boolean' ? data.wifiAllowed : allowed;
      const reason =
        data.reason ||
        (allowed
          ? undefined
          : wifiFingerprintEnabled
            ? scan.error || '未识别到工作室周边 Wi-Fi 环境指纹。'
            : '当前出口网络未在工作室考勤白名单中。');
      return {
        allowed,
        ipAllowed: typeof data.ipAllowed === 'boolean' ? data.ipAllowed : allowed,
        clientIp: data.clientIp,
        reason,
        wifiFingerprintEnabled,
        wifiAllowed,
        matchedCount: typeof data.matchedCount === 'number' ? data.matchedCount : 0,
        requiredMatchCount:
          typeof data.requiredMatchCount === 'number' ? data.requiredMatchCount : 0,
        configuredAnchorCount:
          typeof data.configuredAnchorCount === 'number' ? data.configuredAnchorCount : 0,
        scanError: scan.samples.length === 0 ? scan.error : undefined,
      };
    } catch (err) {
      // 兼容尚未部署 POST /network-policy/current-status 的旧版后端
      if (err instanceof PunchApiError && (err.status === 404 || err.status === 405)) {
        const { data } = await client.get<{
          isAllowed?: boolean;
          allowed?: boolean;
          clientIp?: string;
          reason?: string;
        }>(PUNCH_ENDPOINTS.networkStatus);
        const allowed = Boolean(data.isAllowed ?? data.allowed);
        return {
          allowed,
          clientIp: data.clientIp,
          reason: data.reason || (allowed ? undefined : '当前出口网络未在工作室考勤白名单中。'),
        };
      }
      throw err;
    }
  },

  async fetchWifiFingerprintConfig(): Promise<WifiFingerprintConfig> {
    const { data } = await client.get<WifiFingerprintConfig>(PUNCH_ENDPOINTS.adminWifiFingerprint);
    return {
      teamId: data.teamId ?? '',
      enabled: Boolean(data.enabled),
      anchors: Array.isArray(data.anchors) ? data.anchors : [],
      minMatchCount: typeof data.minMatchCount === 'number' ? data.minMatchCount : 2,
      minRssi: typeof data.minRssi === 'number' ? data.minRssi : -82,
      updatedAt: data.updatedAt ?? null,
    };
  },

  async updateWifiFingerprintConfig(
    input: UpdateWifiFingerprintInput,
  ): Promise<WifiFingerprintConfig> {
    const { data } = await client.patch<WifiFingerprintConfig>(
      PUNCH_ENDPOINTS.adminWifiFingerprint,
      input,
    );
    return {
      teamId: data.teamId ?? '',
      enabled: Boolean(data.enabled),
      anchors: Array.isArray(data.anchors) ? data.anchors : [],
      minMatchCount: typeof data.minMatchCount === 'number' ? data.minMatchCount : 2,
      minRssi: typeof data.minRssi === 'number' ? data.minRssi : -82,
      updatedAt: data.updatedAt ?? null,
    };
  },

  async fetchTeamActive(): Promise<TeamActiveMember[]> {
    const { data } = await client.get<unknown>(PUNCH_ENDPOINTS.teamActive);
    const raw = unwrapArray<Record<string, unknown>>(data, 'items');
    return raw.map((item) => {
      const realName = typeof item.realName === 'string' && item.realName.trim() ? item.realName.trim() : undefined;
      const nickname =
        typeof item.displayName === 'string' && item.displayName.trim() ? item.displayName.trim() : undefined;
      return {
        userId: String(item.memberKey ?? item.userId ?? ''),
        displayName: formatMemberDisplayName({
          realName,
          displayName: nickname,
          username: item.username,
        }),
        realName,
        nickname,
        avatar:
          typeof item.avatarUrl === 'string' && item.avatarUrl
            ? item.avatarUrl
            : typeof item.avatarBase64 === 'string' && item.avatarBase64
              ? item.avatarBase64
              : typeof item.avatar === 'string'
                ? item.avatar
                : undefined,
        teamName:
          typeof item.teamName === 'string'
            ? item.teamName
            : item.enrollYear
              ? `${item.enrollYear} 级`
              : undefined,
        checkedInAt: String(item.checkInAt ?? item.checkedInAt ?? new Date().toISOString()),
        durationSeconds: Number(item.elapsedSeconds ?? item.durationSeconds ?? 0),
        titles: normalizeTitleBadges(item.titles),
      };
    });
  },

  async fetchMyWeeklyStats(): Promise<MyWeeklyStats> {
    const { data } = await client.get<{
      items?: Array<{
        weekKey?: string;
        totalDurationSeconds?: number;
        weeklyGoalSeconds?: number;
        assessmentComplete?: boolean;
      }>;
      weeklyGoalSeconds?: number;
      week?: string;
      totalDurationSeconds?: number;
      targetDurationSeconds?: number;
      qualified?: boolean;
    }>(PUNCH_ENDPOINTS.myWeeklyStats);

    if (Array.isArray(data.items) && data.items.length > 0) {
      const latest = data.items[0]!;
      const total = Number(latest.totalDurationSeconds ?? 0);
      const target = Number(latest.weeklyGoalSeconds ?? data.weeklyGoalSeconds ?? 18 * 3600);
      return {
        week: latest.weekKey ?? '',
        totalDurationSeconds: total,
        targetDurationSeconds: target,
        qualified: Boolean(latest.assessmentComplete ?? total >= target),
      };
    }

    const total = Number(data.totalDurationSeconds ?? 0);
    const target = Number(data.targetDurationSeconds ?? data.weeklyGoalSeconds ?? 18 * 3600);
    return {
      week: data.week ?? '',
      totalDurationSeconds: total,
      targetDurationSeconds: target,
      qualified: Boolean(data.qualified ?? total >= target),
    };
  },

  async fetchTeamWeeklyRanking(): Promise<TeamWeeklyRankingItem[]> {
    const { data } = await client.get<unknown>(PUNCH_ENDPOINTS.teamWeeklyStats);
    const raw = unwrapArray<Record<string, unknown>>(data, 'items');
    return raw.map((item, idx) => {
      const realName = typeof item.realName === 'string' && item.realName.trim() ? item.realName.trim() : undefined;
      const nickname =
        typeof item.displayName === 'string' && item.displayName.trim() ? item.displayName.trim() : undefined;
      return {
        userId: String(item.memberKey ?? item.userId ?? idx),
        displayName: formatMemberDisplayName({
          realName,
          displayName: nickname,
          username: item.username,
        }),
        realName,
        nickname,
        avatar:
          typeof item.avatarUrl === 'string' && item.avatarUrl
            ? item.avatarUrl
            : typeof item.avatarBase64 === 'string' && item.avatarBase64
              ? item.avatarBase64
              : typeof item.avatar === 'string'
                ? item.avatar
                : undefined,
        teamName:
          typeof item.teamName === 'string'
            ? item.teamName
            : item.enrollYear
              ? `${item.enrollYear} 级`
              : undefined,
        totalDurationSeconds: Number(item.totalDurationSeconds ?? 0),
        rank: Number(item.rank ?? idx + 1),
        qualified: Boolean(item.assessmentComplete ?? item.qualified),
        titles: normalizeTitleBadges(item.titles),
      };
    });
  },

  async fetchMyRecords(pageSize = 50): Promise<AttendanceRecordItem[]> {
    const { data } = await client.get<unknown>(PUNCH_ENDPOINTS.myRecords, {
      params: { page: 1, pageSize },
    });
    const raw = unwrapArray<Record<string, unknown>>(data, 'items');
    return raw.map((item) => {
      const checkInTime = String(item.checkInAt ?? item.checkInTime ?? '');
      const checkOutRaw = item.checkOutAt ?? item.checkOutTime;
      return {
        id: String(item.id ?? item._id ?? checkInTime),
        checkInTime,
        checkOutTime: typeof checkOutRaw === 'string' ? checkOutRaw : null,
        durationSeconds: Number(item.durationSeconds ?? item.creditedSeconds ?? 0),
        status: typeof item.status === 'string' ? item.status : undefined,
        date: checkInTime ? checkInTime.slice(0, 10) : undefined,
      };
    });
  },

  async fetchPoints(week?: string): Promise<PointsSummary> {
    const { data } = await client.get<{
      totalPoints?: number;
      drawPoints?: { balance?: number; earned?: number; bonus?: number };
      cardsCount?: number;
    }>(PUNCH_ENDPOINTS.myPoints, {
      params: week ? { week } : undefined,
    });
    return {
      totalPoints: Number(data.totalPoints ?? 0),
      weekPoints:
        typeof data.drawPoints?.balance === 'number' ? data.drawPoints.balance : undefined,
      cardsCount: typeof data.cardsCount === 'number' ? data.cardsCount : undefined,
    };
  },

  async fetchWeeklyReport(week: string): Promise<WeeklyReportItem | null> {
    const { data } = await client.get<{ item?: WeeklyReportItem | null }>(
      PUNCH_ENDPOINTS.myWeeklyReport,
      { params: { week } },
    );
    return data?.item ?? null;
  },

  async saveWeeklyReport(week: string, content: string): Promise<WeeklyReportItem> {
    const { data } = await client.put<{ item?: WeeklyReportItem }>(
      PUNCH_ENDPOINTS.myWeeklyReport,
      { content },
      { params: { week } },
    );
    return data?.item ?? { week, content };
  },

  async fetchTeamEvents(): Promise<TeamEventItem[]> {
    const { data } = await client.get<unknown>(PUNCH_ENDPOINTS.teamEvents);
    const raw = unwrapArray<Record<string, unknown>>(data, 'items');
    return raw.map((item) => ({
      id: String(item.id ?? item._id ?? ''),
      title: String(item.title ?? ''),
      description: typeof item.description === 'string' ? item.description : undefined,
      startAt: String(item.eventAt ?? item.startAt ?? ''),
      endAt: typeof item.endAt === 'string' ? item.endAt : undefined,
      location: typeof item.location === 'string' ? item.location : undefined,
      status: typeof item.status === 'string' ? item.status : undefined,
    }));
  },

  async fetchNotifications(status = 'all', limit = 30): Promise<PunchNotificationItem[]> {
    const { data } = await client.get<unknown>(PUNCH_ENDPOINTS.notifications, {
      params: { status, limit },
    });
    const raw = unwrapArray<Record<string, unknown>>(data, 'items');
    return raw.map((item) => ({
      id: String(item.id ?? item._id ?? ''),
      title: String(item.title ?? '系统通知'),
      body: String(item.message ?? item.body ?? ''),
      status: item.acknowledgedAt ? 'acknowledged' : 'unread',
      createdAt: String(item.createdAt ?? new Date().toISOString()),
    }));
  },

  async acknowledgeNotification(id: string): Promise<void> {
    await client.patch(PUNCH_ENDPOINTS.ackNotification(id));
  },

  async fetchMyTitles(): Promise<MyTitlesView> {
    const { data } = await client.get<MyTitlesView>(PUNCH_ENDPOINTS.titlesMe);
    return {
      weekKey: data.weekKey ?? '',
      equippedTitleId: data.equippedTitleId ?? null,
      displayTitles: normalizeTitleBadges(data.displayTitles),
      catalog: Array.isArray(data.catalog) ? data.catalog : [],
    };
  },

  async equipTitle(titleId: string | null): Promise<MyTitlesView> {
    const { data } = await client.patch<MyTitlesView>(PUNCH_ENDPOINTS.titlesEquip, { titleId });
    return {
      weekKey: data.weekKey ?? '',
      equippedTitleId: data.equippedTitleId ?? null,
      displayTitles: normalizeTitleBadges(data.displayTitles),
      catalog: Array.isArray(data.catalog) ? data.catalog : [],
    };
  },

  async fetchCardGame(): Promise<CardGameView> {
    const { data } = await client.get<CardGameView>(PUNCH_ENDPOINTS.cardsMe);
    return data;
  },

  async performCardAction(input: CardGameActionInput): Promise<CardGameActionResponse> {
    const { data } = await client.post<CardGameActionResponse>(PUNCH_ENDPOINTS.cardsActions, input);
    return data;
  },

  async acknowledgeCardGifts(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await client.post(PUNCH_ENDPOINTS.cardsGiftsAck, { ids });
  },

  async acknowledgeCardDefenses(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await client.post(PUNCH_ENDPOINTS.cardsDefensesAck, { ids });
  },

  async acknowledgeCardInteractions(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await client.post(PUNCH_ENDPOINTS.cardsInteractionsAck, { ids });
  },

  getCachedCardArtUrl(cardId: string): string | null {
    return cardArtUrlCache.get(cardId) ?? null;
  },

  async fetchCardArtUrl(cardId: string, signal?: AbortSignal): Promise<string> {
    const cached = cardArtUrlCache.get(cardId);
    if (cached) return cached;

    const existing = cardArtInFlight.get(cardId);
    if (existing) return existing;

    const task = (async () => {
      // 1. 优先命中本地磁盘 CacheStorage（重启后秒出卡面，无需重复从 RustFS 下载 2MB 原图）
      const diskBlob = await readCardArtFromDiskCache(cardId);
      if (diskBlob) {
        const url = URL.createObjectURL(diskBlob);
        cardArtUrlCache.set(cardId, url);
        return url;
      }
      // 2. 回源拉取并写入本地持久缓存
      const { data } = await client.get<Blob>(PUNCH_ENDPOINTS.cardsArt(cardId), {
        responseType: 'blob',
        signal,
      });
      void writeCardArtToDiskCache(cardId, data);
      const url = URL.createObjectURL(data);
      cardArtUrlCache.set(cardId, url);
      return url;
    })().finally(() => {
      cardArtInFlight.delete(cardId);
    });

    cardArtInFlight.set(cardId, task);
    return task;
  },

  prefetchCardArt(cardIds: string[]): void {
    const pending = cardIds.filter((id) => !cardArtUrlCache.has(id) && !cardArtInFlight.has(id)).slice(0, 8);
    if (pending.length === 0) return;
    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        const id = pending[cursor++]!;
        try {
          await punchApi.fetchCardArtUrl(id);
        } catch {
          // 静默跳过预热失败
        }
      }
    };
    void Promise.all([worker(), worker()]);
  },
};
