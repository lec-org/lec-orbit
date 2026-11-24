import axios from 'axios';
import { getOrbitEndpoints } from '@shared/env';
import { getOrbitClient } from './orbitClient';

export interface BlogApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
  timestamp: string;
}

export interface MemberBlogItem {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  isCaptain: boolean;
  blogUrl: string;
  blogTitle: string;
  bio: string;
  tags: string[];
  rssUrl: string | null;
  hasRecentPost: boolean;
  latestPostTitle: string | null;
  latestPostUrl: string | null;
  latestPostAt: string | null;
  updatedAt: string;
}

export interface MyBlogDetail extends MemberBlogItem {
  status: 'ACTIVE' | 'HIDDEN';
  lastSyncedAt: string | null;
  syncError: string | null;
}

export interface UpsertMyBlogPayload {
  blogUrl: string;
  blogTitle?: string;
  bio?: string;
  tags?: string[];
  rssUrl?: string;
  autoDiscoverRss?: boolean;
}

export interface BlogPostItem {
  id: number;
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  blogTitle: string;
  title: string;
  postUrl: string;
  summary: string;
  sourceType: 'RSS' | 'NATIVE';
  publishedAt: string;
}

export interface BlogPageResult<T> {
  page: number;
  size: number;
  total: number;
  items: T[];
}

export class BlogApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'BlogApiError';
  }
}

export function unwrapBlogResponse<T>(envelope: BlogApiEnvelope<T> | null | undefined, status: number): T {
  if (status < 200 || status >= 300 || envelope?.code !== 0 || !('data' in envelope)) {
    const message = typeof envelope?.message === 'string' && envelope.message && envelope.message !== 'ok'
      ? envelope.message
      : '博客服务返回了无效响应';
    throw new BlogApiError(message, status);
  }
  return envelope.data;
}

const baseURL = getOrbitEndpoints().blogApiBase;
const localApi = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname);
const devUserId = import.meta.env?.DEV && localApi ? import.meta.env.VITE_BLOG_DEV_USER_ID?.trim() : undefined;

export function hasBlogDevIdentity(): boolean {
  return Boolean(devUserId);
}

export function hasBlogDevCaptain(): boolean {
  return hasBlogDevIdentity() && import.meta.env.VITE_BLOG_DEV_CAPTAIN === 'true';
}

const client = axios.create({
  baseURL,
  timeout: 30_000,
  headers: { Accept: 'application/json' },
});

client.interceptors.request.use(async (config) => {
  const token = await getOrbitClient().auth.getApiToken('orbit');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  } else if (devUserId) {
    config.headers.set('X-Dev-User-Id', devUserId);
    const username = import.meta.env.VITE_BLOG_DEV_USERNAME;
    const displayName = import.meta.env.VITE_BLOG_DEV_DISPLAY_NAME;
    const avatar = import.meta.env.VITE_BLOG_DEV_AVATAR;
    if (username) config.headers.set('X-Dev-Username', username);
    if (displayName) config.headers.set('X-Dev-Display-Name', displayName);
    if (avatar) config.headers.set('X-Dev-Avatar', avatar);
    if (hasBlogDevCaptain()) config.headers.set('X-Dev-Captain', 'true');
  }
  return config;
});

async function request<T>(method: 'GET' | 'PUT' | 'DELETE' | 'POST', url: string, options: {
  params?: Record<string, unknown>;
  data?: UpsertMyBlogPayload;
  signal?: AbortSignal;
} = {}): Promise<T> {
  try {
    const response = await client.request<BlogApiEnvelope<T>>({ method, url, ...options, validateStatus: () => true });
    return unwrapBlogResponse(response.data, response.status);
  } catch (error) {
    if (axios.isAxiosError(error) && !axios.isCancel(error)) {
      throw new BlogApiError('无法连接博客服务，请稍后重试', error.response?.status ?? 0);
    }
    throw error;
  }
}

export const blogApi = {
  listBlogs(params?: { q?: string; tag?: string; sort?: 'recent' | 'updated' }): Promise<MemberBlogItem[]> {
    return request('GET', '/api/v1/blogs', { params });
  },
  getMyBlog(signal?: AbortSignal): Promise<MyBlogDetail | null> {
    return request('GET', '/api/v1/blogs/me', { signal });
  },
  upsertMyBlog(data: UpsertMyBlogPayload): Promise<MyBlogDetail> {
    return request('PUT', '/api/v1/blogs/me', { data });
  },
  deleteMyBlog(): Promise<null> {
    return request('DELETE', '/api/v1/blogs/me');
  },
  syncMyBlog(): Promise<null> {
    return request('POST', '/api/v1/blogs/me/sync');
  },
  listAuthorPosts(userId: string, page: number, size: number, signal?: AbortSignal): Promise<BlogPageResult<BlogPostItem>> {
    return request('GET', `/api/v1/blogs/${encodeURIComponent(userId)}/posts`, { params: { page, size }, signal });
  },
  listRecentPosts(page: number, size: number, signal?: AbortSignal): Promise<BlogPageResult<BlogPostItem>> {
    return request('GET', '/api/v1/posts/recent', { params: { page, size }, signal });
  },
  listHiddenBlogs(signal?: AbortSignal): Promise<MemberBlogItem[]> {
    return request('GET', '/api/v1/admin/blogs/hidden', { signal });
  },
  adminHideBlog(userId: string): Promise<null> {
    return request('DELETE', `/api/v1/admin/blogs/${encodeURIComponent(userId)}`);
  },
  adminRestoreBlog(userId: string): Promise<null> {
    return request('POST', `/api/v1/admin/blogs/${encodeURIComponent(userId)}/restore`);
  },
};
