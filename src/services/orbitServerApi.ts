/** Orbit Go + Gin 后端接口与 WebSocket 实时推送客户端。 */
import axios, { AxiosError } from 'axios';
import { getOrbitEndpoints } from '@shared/env';
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
