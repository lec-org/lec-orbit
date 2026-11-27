/** Orbit 后端接口与 WebSocket 实时推送客户端。 */
import axios, { AxiosError } from 'axios';
import { getOrbitEndpoints } from '@shared/env';
import type { MiniAppCatalogItem, MiniAppDetail, OrbitAppManifest } from '@shared/miniapp';
import { getOrbitClient } from './orbitClient';

export interface OrbitAnnouncement {
  id: string;
  title: string;
  contentHtml: string;
  contentText: string;
  pinned: boolean;
  authorId: string;
  authorName: string;
  authorAvatar: string;
  readCount: number;
  totalCount: number;
  isReadByMe: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OrbitReceiptMember {
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  isCaptain: boolean;
  readAt?: string;
}

export interface OrbitAnnouncementReceipts {
  announcementId: string;
  readCount: number;
  unreadCount: number;
  totalCount: number;
  read: OrbitReceiptMember[];
  unread: OrbitReceiptMember[];
}

export interface OrbitNotificationItem {
  id: string;
  sourceApp: string;
  eventType: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  targetUserId?: string;
  actionStatus?: 'pending' | 'approved' | 'denied' | 'expired';
  actionNote?: string;
  actionBy?: string;
  actionAt?: string;
  isRead: boolean;
  createdAt: string;
}

export interface MiniAppFunctionSourceFile {
  path: string;
  isBinary: boolean;
  sizeBytes: number;
  source: string | null;
}

export interface MiniAppVersionFunctionsSource {
  appId: string;
  versionId: string;
  version?: string;
  hasFunctions: boolean;
  routes: string[];
  timeoutMs?: number;
  allowStreaming?: boolean;
  sha256?: string;
  files: MiniAppFunctionSourceFile[];
}

export interface MiniAppSecretSummary {
  name: string;
  updatedBy: string;
  updatedAt: string;
}

export interface MiniAppFnLogEntry {
  requestId: string;
  fnName: string;
  userId: string;
  status: number;
  durationMs: number;
  logs: Array<{ level: string; text: string }>;
  error?: string;
  createdAt: string;
}

export interface ActiveHubPlayer {
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  enrollYear: number | null;
  appId: string;
  appName: string;
  appType: string;
  appIconUrl: string;
  startedAt: string;
}

export interface MiniAppReviewItem {
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  enrollYear: number | null;
  score: number;
  comment: string;
  ratedAt: string;
}

export interface MiniAppPlayerStatItem {
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  enrollYear: number | null;
  playCount: number;
  totalDurationSeconds: number;
  lastPlayedAt: string;
  score: number | null;
  comment: string;
}

export interface MiniAppDailyTrendPoint {
  day: string;
  plays: number;
  uniquePlayers: number;
}

export interface MiniAppEngagementStats {
  appId: string;
  appName: string;
  ownerId: string;
  totalPlays: number;
  uniquePlayers: number;
  avgRating: number | null;
  ratingCount: number;
  activePlayers: ActiveHubPlayer[];
  myPlayCount: number;
  myRating: { score: number; comment: string; ratedAt: string } | null;
  myRatingChances: number;
  isOwner: boolean;
  dailyRatingsRemaining: number;
  dailyAppRatingsRemaining: number;
  dailyMaxRatingsGlobal: number;
  dailyMaxRatingsPerApp: number;
  canViewPlayers: boolean;
  dailyTrend?: MiniAppDailyTrendPoint[];
  reviews: MiniAppReviewItem[];
  players: MiniAppPlayerStatItem[];
}

export interface MiniAppLeaderboardItem {
  rank: number;
  appId: string;
  name: string;
  type: string;
  engine: string;
  iconUrl: string;
  description: string;
  ownerId: string;
  ownerName: string;
  totalPlays: number;
  uniquePlayers: number;
  avgRating: number | null;
  ratingCount: number;
  bayesianScore: number;
  activePlayerCount: number;
  myRatingChances: number;
  myRatingScore: number | null;
}

export type StudioAttendeeResponse = 'accepted' | 'tentative' | 'declined';

export interface StudioCalendarEventDTO {
  id: string;
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  reminderMinutes: number | null;
  attendeeUserIds?: string[];
  attendeeGrades?: number[];
  attendeeResponses?: Record<string, StudioAttendeeResponse>;
  creatorId: string;
  creatorName: string;
  creatorAvatar: string;
  createdAt: string;
  updatedAt: string;
}

export interface StudioCalendarEventPayload {
  title: string;
  description?: string;
  location?: string;
  allDay?: boolean;
  startDate: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  reminderMinutes?: number | null;
  attendeeUserIds?: string[];
  attendeeGrades?: number[];
}

export interface FreeBusyBlockDTO {
  id: string;
  kind: 'course' | 'personal' | 'studio';
  title: string;
  location: string;
  allDay: boolean;
  startTime: string;
  endTime: string;
  color: string;
  status: StudioAttendeeResponse;
  meta?: string;
}

export interface MemberFreeBusyTimelineDTO {
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  enrollYear: number | null;
  isCaptain: boolean;
  hasScheduleSynced: boolean;
  snapshotUpdatedAt: string | null;
  blocks: FreeBusyBlockDTO[];
}

export interface FreeBusySnapshotPayload {
  schedule: {
    scheduleName: string;
    startDate: string;
    totalWeeks: number;
    weekStartDay: number;
    slots: Array<{ section: number; startTime: string; endTime: string }>;
    courses: Array<{
      id: string;
      name: string;
      color: string;
      meetings: Array<{
        id: string;
        dayOfWeek: number;
        startSection: number;
        endSection: number;
        weeks: number[];
        location: string;
        teacher: string;
      }>;
    }>;
  } | null;
  personalEvents: Array<{
    id: string;
    title: string;
    location: string;
    allDay: boolean;
    startDate: string;
    endDate: string;
    startTime: string;
    endTime: string;
    color: string;
    calendarName: string;
  }>;
}

export interface OrbitWsEvent {
  type:
    | 'announcement.created'
    | 'announcement.updated'
    | 'announcement.deleted'
    | 'announcement.receipt'
    | 'notification.created'
    | 'notification.updated'
    | 'miniapp.realtime'
    | 'hub.presence.updated'
    | 'studio_calendar.created'
    | 'studio_calendar.updated'
    | 'studio_calendar.deleted';
  payload: Record<string, unknown>;
}

const client = axios.create({
  baseURL: getOrbitEndpoints().orbitApiBase,
  timeout: 15_000,
  headers: { Accept: 'application/json' },
});

client.interceptors.request.use(async (config) => {
  const token = await getOrbitClient().auth.getApiToken('orbit');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

client.interceptors.response.use(
  (res) => res,
  (err: unknown) => {
    if (err instanceof AxiosError) {
      const msg = (err.response?.data as { error?: string } | undefined)?.error;
      return Promise.reject(new Error(msg || err.message || '请求 Orbit 服务失败'));
    }
    return Promise.reject(err);
  },
);

export const orbitServerApi = {
  async listAnnouncements(): Promise<OrbitAnnouncement[]> {
    const { data } = await client.get<{ items: OrbitAnnouncement[] }>('/api/v1/announcements');
    return data.items ?? [];
  },

  async createAnnouncement(input: {
    title: string;
    contentHtml: string;
    pinned: boolean;
  }): Promise<OrbitAnnouncement> {
    const { data } = await client.post<OrbitAnnouncement>('/api/v1/announcements', input);
    return data;
  },

  async updateAnnouncement(
    id: string,
    input: { title?: string; contentHtml?: string; pinned?: boolean },
  ): Promise<void> {
    await client.patch(`/api/v1/announcements/${encodeURIComponent(id)}`, input);
  },

  async deleteAnnouncement(id: string): Promise<void> {
    await client.delete(`/api/v1/announcements/${encodeURIComponent(id)}`);
  },

  async markAnnouncementRead(
    id: string,
  ): Promise<{ announcementId: string; readCount: number; totalCount: number }> {
    const { data } = await client.post<{
      announcementId: string;
      readCount: number;
      totalCount: number;
    }>(`/api/v1/announcements/${encodeURIComponent(id)}/read`);
    return data;
  },

  async getAnnouncementReceipts(id: string): Promise<OrbitAnnouncementReceipts> {
    const { data } = await client.get<OrbitAnnouncementReceipts>(
      `/api/v1/announcements/${encodeURIComponent(id)}/receipts`,
    );
    return data;
  },

  async remindUnread(id: string): Promise<{ remindedCount: number }> {
    const { data } = await client.post<{ remindedCount: number }>(
      `/api/v1/announcements/${encodeURIComponent(id)}/remind-unread`,
    );
    return data;
  },

  async uploadAnnouncementImage(file: File): Promise<string> {
    const form = new FormData();
    form.append('file', file);
    const { data } = await client.post<{ url: string }>('/api/v1/uploads/image', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data.url;
  },

  async listNotifications(params?: {
    sourceApp?: string;
    unreadOnly?: boolean;
  }): Promise<OrbitNotificationItem[]> {
    const { data } = await client.get<{ items: OrbitNotificationItem[] }>('/api/v1/notifications', {
      params,
    });
    return data.items ?? [];
  },

  async markNotificationRead(id: string): Promise<void> {
    await client.post(`/api/v1/notifications/${encodeURIComponent(id)}/read`);
  },

  async markAllNotificationsRead(): Promise<void> {
    await client.post('/api/v1/notifications/read-all');
  },

  async handleNotificationAction(
    id: string,
    decision: 'approve' | 'deny',
    note?: string,
  ): Promise<{ id: string; actionStatus: 'approved' | 'denied' }> {
    const { data } = await client.post<{ id: string; actionStatus: 'approved' | 'denied' }>(
      `/api/v1/notifications/${encodeURIComponent(id)}/action`,
      { decision, note },
    );
    return data;
  },

  async createDocEditRequest(
    pageKey: string,
    reason: string,
  ): Promise<{ ok: boolean; requestId: string; pageTitle: string; authorName: string; description: string }> {
    const { data } = await client.post('/api/v1/doc-requests', { pageKey, reason });
    return data;
  },

  async listMiniApps(params?: {
    type?: 'miniapp' | 'minigame';
    engine?: string;
    q?: string;
    mine?: boolean;
    pending?: boolean;
  }): Promise<MiniAppCatalogItem[]> {
    try {
      const { data } = await client.get<{ items: MiniAppCatalogItem[] }>('/api/v1/apps', {
        params: {
          ...(params?.type ? { type: params.type } : {}),
          ...(params?.engine && params.engine !== 'all' ? { engine: params.engine } : {}),
          ...(params?.q ? { q: params.q } : {}),
          ...(params?.mine ? { mine: '1' } : {}),
          ...(params?.pending ? { pending: '1' } : {}),
        },
      });
      return data.items ?? [];
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) {
        throw new Error(
          '当前连接的 Orbit 服务端尚未升级工坊接口（HTTP 404）；内置示例与本地调试均可正常使用，发布新版 lec-orbit-server 后即可同步线上作品。',
        );
      }
      throw err;
    }
  },

  async getMiniApp(id: string): Promise<MiniAppDetail> {
    const { data } = await client.get<MiniAppDetail>(`/api/v1/apps/${encodeURIComponent(id)}`);
    return data;
  },

  async uploadMiniAppZip(input: {
    blob: Blob;
    fileName: string;
    targetAppId?: string;
    channel: 'preview' | 'release';
    changelog: string;
    directPublish?: boolean;
  }): Promise<MiniAppCatalogItem> {
    const form = new FormData();
    form.append('file', input.blob, input.fileName);
    form.append('channel', input.channel);
    form.append('changelog', input.changelog);
    if (input.targetAppId) form.append('targetAppId', input.targetAppId);
    if (input.directPublish) {
      form.append('directPublish', 'true');
    }
    const { data } = await client.post<MiniAppCatalogItem>('/api/v1/apps/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120_000,
    });
    return data;
  },

  async importGitHubMiniApp(input: {
    targetAppId?: string;
    bundleUrl: string;
    bundleSha256: string;
    bundleSize?: number;
    iconUrl?: string;
    channel: 'preview' | 'release';
    changelog: string;
    directPublish?: boolean;
    manifest: OrbitAppManifest;
  }): Promise<MiniAppCatalogItem> {
    const { data } = await client.post<MiniAppCatalogItem>('/api/v1/apps/import-github', input);
    return data;
  },

  async reviewMiniAppVersion(
    appId: string,
    versionId: string,
    decision: 'approve' | 'reject',
    note?: string,
  ): Promise<void> {
    await client.post(
      `/api/v1/apps/${encodeURIComponent(appId)}/versions/${encodeURIComponent(versionId)}/review`,
      { decision, note: note ?? '' },
    );
  },

  async withdrawMiniAppVersion(appId: string, versionId: string): Promise<void> {
    await client.post(
      `/api/v1/apps/${encodeURIComponent(appId)}/versions/${encodeURIComponent(versionId)}/withdraw`,
    );
  },

  async resubmitMiniAppVersion(appId: string, versionId: string): Promise<void> {
    await client.post(
      `/api/v1/apps/${encodeURIComponent(appId)}/versions/${encodeURIComponent(versionId)}/resubmit`,
    );
  },

  async updateMiniAppStatus(
    appId: string,
    payload: { status?: 'published' | 'suspended' | 'draft'; activeVersionId?: string },
  ): Promise<void> {
    await client.post(`/api/v1/apps/${encodeURIComponent(appId)}/status`, payload);
  },

  async recordMiniAppPlay(appId: string): Promise<void> {
    await client.post(`/api/v1/apps/${encodeURIComponent(appId)}/play`).catch(() => undefined);
  },

  async listMiniAppPresence(): Promise<ActiveHubPlayer[]> {
    const { data } = await client.get<{ items: ActiveHubPlayer[] }>('/api/v1/apps/presence');
    return data.items ?? [];
  },

  async getMiniAppLeaderboard(params?: {
    sort?: 'composite' | 'rating' | 'plays';
    type?: 'all' | 'minigame' | 'miniapp';
  }): Promise<{ sort: 'composite' | 'rating' | 'plays'; items: MiniAppLeaderboardItem[] }> {
    const { data } = await client.get<{
      sort: 'composite' | 'rating' | 'plays';
      items: MiniAppLeaderboardItem[];
    }>('/api/v1/apps/leaderboard', {
      params: {
        ...(params?.sort ? { sort: params.sort } : {}),
        ...(params?.type && params.type !== 'all' ? { type: params.type } : {}),
      },
    });
    return { sort: data.sort ?? 'composite', items: data.items ?? [] };
  },

  async getMiniAppStats(appId: string): Promise<MiniAppEngagementStats> {
    const { data } = await client.get<MiniAppEngagementStats>(
      `/api/v1/apps/${encodeURIComponent(appId)}/stats`,
    );
    return data;
  },

  async rateMiniApp(
    appId: string,
    input: { score: number; comment?: string },
  ): Promise<{
    ok: true;
    avgRating: number | null;
    ratingCount: number;
    myRating: { score: number; comment: string; ratedAt: string };
    myRatingChances: number;
    dailyRatingsRemaining: number;
    dailyAppRatingsRemaining: number;
  }> {
    const { data } = await client.post(
      `/api/v1/apps/${encodeURIComponent(appId)}/rate`,
      input,
    );
    return data;
  },

  // ── 托管云函数 FaaS（源码审查 / 加密 Secrets / 调用日志）──

  async getMiniAppFunctionsSource(
    appId: string,
    versionId: string,
  ): Promise<MiniAppVersionFunctionsSource> {
    const { data } = await client.get<MiniAppVersionFunctionsSource>(
      `/api/v1/apps/${encodeURIComponent(appId)}/versions/${encodeURIComponent(versionId)}/functions`,
    );
    return data;
  },

  async listMiniAppSecrets(appId: string): Promise<MiniAppSecretSummary[]> {
    const { data } = await client.get<{ items: MiniAppSecretSummary[] }>(
      `/api/v1/apps/${encodeURIComponent(appId)}/secrets`,
    );
    return data.items ?? [];
  },

  async upsertMiniAppSecret(appId: string, name: string, value: string): Promise<void> {
    await client.put(
      `/api/v1/apps/${encodeURIComponent(appId)}/secrets/${encodeURIComponent(name)}`,
      { value },
    );
  },

  async deleteMiniAppSecret(appId: string, name: string): Promise<void> {
    await client.delete(
      `/api/v1/apps/${encodeURIComponent(appId)}/secrets/${encodeURIComponent(name)}`,
    );
  },

  async listMiniAppFnLogs(appId: string, limit = 50): Promise<MiniAppFnLogEntry[]> {
    const { data } = await client.get<{ items: MiniAppFnLogEntry[] }>(
      `/api/v1/apps/${encodeURIComponent(appId)}/fn-logs`,
      { params: { limit } },
    );
    return data.items ?? [];
  },

  async listStudioCalendarEvents(range?: {
    from?: string;
    to?: string;
  }): Promise<StudioCalendarEventDTO[]> {
    const { data } = await client.get<{ items: StudioCalendarEventDTO[] }>(
      '/api/v1/studio-calendar/events',
      { params: range },
    );
    return data.items ?? [];
  },

  async createStudioCalendarEvent(
    input: StudioCalendarEventPayload,
  ): Promise<StudioCalendarEventDTO> {
    const { data } = await client.post<StudioCalendarEventDTO>(
      '/api/v1/studio-calendar/events',
      input,
    );
    return data;
  },

  async updateStudioCalendarEvent(
    id: string,
    input: Partial<StudioCalendarEventPayload>,
  ): Promise<StudioCalendarEventDTO> {
    const { data } = await client.patch<StudioCalendarEventDTO>(
      `/api/v1/studio-calendar/events/${encodeURIComponent(id)}`,
      input,
    );
    return data;
  },

  async deleteStudioCalendarEvent(id: string): Promise<void> {
    await client.delete(`/api/v1/studio-calendar/events/${encodeURIComponent(id)}`);
  },

  async rsvpStudioCalendarEvent(
    id: string,
    status: StudioAttendeeResponse,
  ): Promise<StudioCalendarEventDTO> {
    const { data } = await client.post<StudioCalendarEventDTO>(
      `/api/v1/studio-calendar/events/${encodeURIComponent(id)}/rsvp`,
      { status },
    );
    return data;
  },

  async upsertFreeBusySnapshot(
    payload: FreeBusySnapshotPayload,
  ): Promise<{ ok: true; updatedAt: string }> {
    const { data } = await client.put<{ ok: true; updatedAt: string }>(
      '/api/v1/studio-calendar/freebusy/snapshot',
      payload,
    );
    return data;
  },

  async queryFreeBusy(input: {
    date: string;
    userIds?: string[];
    grades?: number[];
    excludeEventId?: string;
  }): Promise<{ date: string; members: MemberFreeBusyTimelineDTO[] }> {
    const { data } = await client.post<{
      date: string;
      members: MemberFreeBusyTimelineDTO[];
    }>('/api/v1/studio-calendar/freebusy/query', input);
    return data;
  },
};

/** 建立带自动指数退避重连的 Orbit 实时 WebSocket 订阅。 */
export function connectOrbitWebSocket(onEvent: (event: OrbitWsEvent) => void): () => void {
  let disposed = false;
  let ws: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const scheduleReconnect = () => {
    if (disposed) return;
    const delay = Math.min(30_000, 1500 * Math.pow(1.6, Math.min(attempt, 6)));
    attempt += 1;
    retryTimer = setTimeout(() => void open(), delay);
  };

  const open = async () => {
    if (disposed) return;
    try {
      const token = await getOrbitClient().auth.getApiToken('orbit');
      if (!token || disposed) {
        scheduleReconnect();
        return;
      }
      const wsUrl = `${getOrbitEndpoints().orbitWsUrl}?token=${encodeURIComponent(token)}`;
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        attempt = 0;
      };
      ws.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(String(ev.data)) as OrbitWsEvent;
          if (parsed?.type) onEvent(parsed);
        } catch {
          // 忽略非 JSON 心跳帧
        }
      };
      ws.onclose = () => {
        ws = null;
        scheduleReconnect();
      };
      ws.onerror = () => {
        ws?.close();
      };
    } catch {
      scheduleReconnect();
    }
  };

  void open();

  return () => {
    disposed = true;
    if (retryTimer) clearTimeout(retryTimer);
    ws?.close();
    ws = null;
  };
}
