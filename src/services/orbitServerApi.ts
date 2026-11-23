/** Orbit Go + Gin 后端接口与 WebSocket 实时推送客户端。 */
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
  actionStatus?: 'pending' | 'approved' | 'denied';
  actionNote?: string;
  actionBy?: string;
  actionAt?: string;
  isRead: boolean;
  createdAt: string;
}

export interface OrbitWsEvent {
  type:
    | 'announcement.created'
    | 'announcement.updated'
    | 'announcement.deleted'
    | 'announcement.receipt'
    | 'notification.created'
    | 'notification.updated';
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
    channel: 'preview' | 'release';
    changelog: string;
    directPublish?: boolean;
  }): Promise<MiniAppCatalogItem> {
    const form = new FormData();
    form.append('file', input.blob, input.fileName);
    form.append('channel', input.channel);
    form.append('changelog', input.changelog);
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

  async updateMiniAppStatus(
    appId: string,
    payload: { status?: 'published' | 'suspended' | 'draft'; activeVersionId?: string },
  ): Promise<void> {
    await client.post(`/api/v1/apps/${encodeURIComponent(appId)}/status`, payload);
  },

  async recordMiniAppPlay(appId: string): Promise<void> {
    await client.post(`/api/v1/apps/${encodeURIComponent(appId)}/play`).catch(() => undefined);
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
