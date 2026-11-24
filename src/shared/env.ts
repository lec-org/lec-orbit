/** Orbit 线上运行配置：统一连接校园正式域名 *.lecspace.top（本机联调可通过环境变量覆写）。 */

import { parseBlogUrl } from './blogUrl';

export interface OrbitEndpoints {
  label: string;
  ssoEndpoint: string;
  ssoClientId: string;
  ssoOrganizationId: string;
  punchApiBase: string;
  punchWebUrl: string;
  punchApiResource: string;
  docWebUrl: string;
  orbitApiBase: string;
  orbitWsUrl: string;
  blogApiBase: string;
  allowedOrigins: readonly string[];
}

declare const __ORBIT_API_BASE__: string | undefined;
declare const __ORBIT_WS_URL__: string | undefined;
declare const __BLOG_API_BASE__: string | undefined;

const definedApiBase = typeof __ORBIT_API_BASE__ !== 'undefined' ? __ORBIT_API_BASE__ : '';
const definedWsUrl = typeof __ORBIT_WS_URL__ !== 'undefined' ? __ORBIT_WS_URL__ : '';
const definedBlogApi = typeof __BLOG_API_BASE__ !== 'undefined' ? __BLOG_API_BASE__ : '';

const orbitApiBase =
  definedApiBase ||
  (typeof process !== 'undefined' ? process.env.ORBIT_API_BASE || process.env.VITE_ORBIT_API_BASE : undefined) ||
  'https://orbit.lecspace.top';
const orbitWsUrl =
  definedWsUrl ||
  (typeof process !== 'undefined' ? process.env.ORBIT_WS_URL || process.env.VITE_ORBIT_WS_URL : undefined) ||
  orbitApiBase.replace(/^http/, 'ws') + '/api/v1/ws';
const blogApiBase = parseBlogUrl(
  definedBlogApi ||
  (typeof process !== 'undefined' ? process.env.BLOG_API_BASE || process.env.VITE_BLOG_API_BASE : undefined),
)?.href.replace(/\/$/, '') || 'https://blog-api.lecspace.top';

export const ORBIT_ENDPOINTS: OrbitEndpoints = {
  label: '校园正式环境',
  ssoEndpoint: 'https://sso.lecspace.top',
  ssoClientId: 'y6dzplzjq61kebk84e1as',
  ssoOrganizationId: 'lec-studio',
  punchApiBase: 'https://punch.lecspace.top/api',
  punchWebUrl: 'https://punch.lecspace.top',
  punchApiResource: 'https://api.lecpunch.lec.org',
  docWebUrl: 'https://doc.lecspace.top',
  orbitApiBase,
  orbitWsUrl,
  blogApiBase,
  allowedOrigins: [
    'https://sso.lecspace.top',
    'https://doc.lecspace.top',
    'https://punch.lecspace.top',
    'https://orbit.lecspace.top',
  ],
};

export function getOrbitEndpoints(): OrbitEndpoints {
  return ORBIT_ENDPOINTS;
}
