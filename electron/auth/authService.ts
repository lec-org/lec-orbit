/**
 * LecSSO 桌面原生认证服务：
 * 1. 默认在主进程走 OIDC PKCE + Logto RFC 0004 Experience API v2，支持 Orbit 100% 原生 Liquid Glass 登录弹窗；
 * 2. 登录完成后将 sso.lecspace.top 的服务端会话 Cookie 同步写入 Electron 共享分区 persist:lec-orbit，
 *    让内嵌 LecDoc 零二次登录直接进入工作区；
 * 3. 同时提供「Orbit 内置无边框子窗」兜底模式，全程不跳外部浏览器；
 * 4. Stage 2 全机授权模式使用独立 OIDC Opaque Token 调用 /api/lec/orbit-auth/*。
 */
import { BrowserWindow, powerMonitor, session, type Session } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { getOrbitEndpoints } from '../../src/shared/env';
import type {
  AccountActionResult,
  AuthState,
  AuthUserProfile,
  ChangePasswordInput,
  MfaVerifyInput,
  OrbitChallengeDetail,
  PasswordSignInInput,
  SignInStepResult,
} from '../../src/shared/ipc';
import type { ConfigStore } from '../storage/configStore';
import type { SecretStore } from '../storage/secretStore';

export const ORBIT_SHARED_PARTITION = 'persist:lec-orbit';

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  revocation_endpoint?: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
}

interface ParsedSetCookie {
  name: string;
  value: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
  expirationDate?: number;
}

interface PendingExperienceFlow {
  redirectUri: string;
  state: string;
  verifier: string;
  cookies: Map<string, ParsedSetCookie>;
  server: http.Server;
  callbackPromise: Promise<string>;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const DEFAULT_SCOPE =
  'openid profile offline_access urn:logto:scope:organizations urn:logto:scope:organization_roles studio:access studio:admin:access';
const REFRESH_SECRET_KEY = 'refresh:campus';

function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return {};
    const json = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseSetCookieHeaders(headers: Headers): ParsedSetCookie[] {
  const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
  const rawList =
    typeof anyHeaders.getSetCookie === 'function'
      ? anyHeaders.getSetCookie()
      : headers.get('set-cookie')
        ? [headers.get('set-cookie')!]
        : [];
  const parsed: ParsedSetCookie[] = [];
  for (const raw of rawList) {
    const parts = raw
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    const first = parts[0] ?? '';
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const item: ParsedSetCookie = {
      name: first.slice(0, eq).trim(),
      value: first.slice(eq + 1).trim(),
    };
    for (const attr of parts.slice(1)) {
      const [kRaw, ...vParts] = attr.split('=');
      const key = kRaw?.trim().toLowerCase();
      const val = vParts.join('=').trim();
      if (key === 'path' && val) item.path = val;
      else if (key === 'httponly') item.httpOnly = true;
      else if (key === 'secure') item.secure = true;
      else if (key === 'max-age') {
        const secs = Number(val);
        if (Number.isFinite(secs)) {
          item.expirationDate = Math.floor(Date.now() / 1000) + secs;
        }
      } else if (key === 'expires') {
        const ts = Date.parse(val);
        if (!Number.isNaN(ts)) {
          item.expirationDate = Math.floor(ts / 1000);
        }
      } else if (key === 'samesite') {
        const lower = val.toLowerCase();
        if (lower === 'strict') item.sameSite = 'strict';
        else if (lower === 'lax') item.sameSite = 'lax';
        else if (lower === 'none') item.sameSite = 'no_restriction';
      }
    }
    parsed.push(item);
  }
  return parsed;
}

function cookieHeaderFromMap(jar: Map<string, ParsedSetCookie>): string {
  return [...jar.values()].map((c) => `${c.name}=${c.value}`).join('; ');
}

export class AuthService {
  private profile: AuthUserProfile | null = null;
  private tokenCache = new Map<'punch' | 'orbit', CachedToken>();
  private discoveryPromise: Promise<OidcDiscovery> | null = null;
  private pendingFlow: PendingExperienceFlow | null = null;
  /** 串行化 refresh_token 轮换，防止并发请求触发 Logto 刷新令牌重放保护导致 401。 */
  private refreshChain: Promise<unknown> = Promise.resolve();
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private resumeHandler: (() => void) | null = null;
  private readonly listeners = new Set<(state: AuthState) => void>();

  constructor(
    private readonly secrets: SecretStore,
    private readonly configStore?: ConfigStore,
  ) {
    // 若本地已加密保存 refresh_token，启动瞬间即恢复上次缓存的用户资料，避免断网或冷启动闪现登录页
    if (this.secrets.getRefreshToken(REFRESH_SECRET_KEY)) {
      this.profile = this.configStore?.get().cachedProfile ?? null;
    }
  }

  private persistProfile(profile: AuthUserProfile | null, handleOverride?: string): void {
    if (!this.configStore) return;
    const patch: { cachedProfile: AuthUserProfile | null; lastLoginHandle?: string } = {
      cachedProfile: profile,
    };
    const nextHandle = handleOverride || profile?.username;
    if (nextHandle) {
      patch.lastLoginHandle = nextHandle;
    }
    try {
      this.configStore.update(patch);
    } catch {
      // 忽略配置写入异常，不影响主认证流程
    }
  }

  /** 启动长效静默保活（每 4 小时 + 系统休眠唤醒），持续滑动续签 Logto refresh_token，减少二次登录。 */
  startKeepAlive(): void {
    if (!this.keepAliveTimer) {
      this.keepAliveTimer = setInterval(() => {
        if (!this.secrets.getRefreshToken(REFRESH_SECRET_KEY)) return;
        void this.silentRefreshSession();
      }, 4 * 60 * 60 * 1000);
    }
    if (!this.resumeHandler && powerMonitor) {
      this.resumeHandler = () => {
        if (!this.secrets.getRefreshToken(REFRESH_SECRET_KEY)) return;
        void this.silentRefreshSession();
      };
      powerMonitor.on('resume', this.resumeHandler);
    }
  }

  dispose(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    if (this.resumeHandler && powerMonitor) {
      powerMonitor.removeListener('resume', this.resumeHandler);
      this.resumeHandler = null;
    }
    this.cleanupPendingFlow();
  }

  private async silentRefreshSession(): Promise<void> {
    const token = await this.getApiToken('orbit', { forceRefresh: true });
    if (token) {
      await this.refreshUserProfile(token).catch(() => undefined);
      this.emit(this.getState());
    }
  }

  getSharedSession(): Session {
    return session.fromPartition(ORBIT_SHARED_PARTITION);
  }

  onStateChanged(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(state: AuthState): void {
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  getState(): AuthState {
    const cfg = getOrbitEndpoints();
    const hasToken = Boolean(
      this.secrets.getRefreshToken(REFRESH_SECRET_KEY) ||
        this.tokenCache.get('orbit') ||
        this.tokenCache.get('punch'),
    );
    const orgs = this.profile?.organizations ?? [];
    const roles = this.profile?.organizationRoles ?? [];
    const isStudioMember = orgs.includes(cfg.ssoOrganizationId);
    // Logto organization_roles 格式为 "<orgId>:<roleName>"，精确区分 captain 与 senior-captain
    const isAdmin = roles.some((raw) => {
      const roleName = (raw.includes(':') ? raw.split(':').pop() : raw)?.toLowerCase() ?? '';
      return roleName === 'captain' || roleName === 'admin' || roleName === 'lec-captain';
    });
    return {
      authenticated: hasToken,
      profile: this.profile,
      isStudioMember,
      isAdmin,
    };
  }

  async restoreSession(): Promise<AuthState> {
    this.startKeepAlive();
    const token = await this.getApiToken('orbit');
    if (token) {
      // 每次启动都在后台刷新最新资料（同步头像/角色变更），同时断网时保留 cachedProfile 不掉登录
      await this.refreshUserProfile(token).catch(() => undefined);
    }
    const state = this.getState();
    this.emit(state);
    return state;
  }

  private async getDiscovery(): Promise<OidcDiscovery> {
    if (!this.discoveryPromise) {
      const cfg = getOrbitEndpoints();
      this.discoveryPromise = fetch(`${cfg.ssoEndpoint}/oidc/.well-known/openid-configuration`)
        .then(async (res) => {
          if (!res.ok) throw new Error(`读取 LecSSO 元数据失败（HTTP ${res.status}）`);
          return (await res.json()) as OidcDiscovery;
        })
        .catch((err) => {
          this.discoveryPromise = null;
          throw err;
        });
    }
    return this.discoveryPromise;
  }

  private createLoopbackCallback(expectedState: string): Promise<{
    server: http.Server;
    redirectUri: string;
    callbackPromise: Promise<string>;
  }> {
    return new Promise((resolveReady, rejectReady) => {
      let resolveCode!: (code: string) => void;
      let rejectCode!: (err: Error) => void;
      const callbackPromise = new Promise<string>((res, rej) => {
        resolveCode = res;
        rejectCode = rej;
      });
      const server = http.createServer((req, res) => {
        const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (reqUrl.pathname !== '/oauth/callback') {
          res.writeHead(404);
          res.end();
          return;
        }
        const error = reqUrl.searchParams.get('error');
        const state = reqUrl.searchParams.get('state');
        const code = reqUrl.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>Orbit</title><p>认证已完成，可关闭此窗口。</p>');
        if (error) {
          rejectCode(new Error(`LecSSO 返回认证错误：${error}`));
          return;
        }
        if (state !== expectedState || !code) {
          rejectCode(new Error('OIDC 回调 state 校验失败或缺少授权码。'));
          return;
        }
        resolveCode(code);
      });
      server.on('error', rejectReady);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          rejectReady(new Error('无法监听本地 OIDC 回调端口。'));
          return;
        }
        resolveReady({
          server,
          redirectUri: `http://127.0.0.1:${addr.port}/oauth/callback`,
          callbackPromise,
        });
      });
    });
  }

  private cleanupPendingFlow(): void {
    if (!this.pendingFlow) return;
    try {
      this.pendingFlow.server.close();
    } catch {
      // 忽略关闭异常
    }
    this.pendingFlow = null;
  }

  private async experienceRequest(
    flow: PendingExperienceFlow,
    pathOrUrl: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; json: Record<string, unknown>; location: string | null }> {
    const cfg = getOrbitEndpoints();
    const url = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : new URL(pathOrUrl, cfg.ssoEndpoint).toString();
    const headers: Record<string, string> = { Accept: 'application/json' };
    const cookie = cookieHeaderFromMap(flow.cookies);
    if (cookie) headers.Cookie = cookie;
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    // 必须使用 Node 原生 fetch（undici），避免 Chromium net.fetch 屏蔽 Cookie 请求头与 Set-Cookie 响应头
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers,
      body,
      redirect: 'manual',
    });
    for (const c of parseSetCookieHeaders(response.headers)) {
      if (c.value && (c.expirationDate === undefined || c.expirationDate > Math.floor(Date.now() / 1000))) {
        flow.cookies.set(c.name, c);
      } else {
        flow.cookies.delete(c.name);
      }
    }
    let json: Record<string, unknown> = {};
    const text = await response.text();
    if (text) {
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // 非 JSON 响应跳过解析
      }
    }
    return { status: response.status, json, location: response.headers.get('location') };
  }

  private async syncCookiesToSharedSession(cookies: Map<string, ParsedSetCookie>): Promise<void> {
    const cfg = getOrbitEndpoints();
    const ses = this.getSharedSession();
    const secure = cfg.ssoEndpoint.startsWith('https://');
    const defaultExp = Math.floor(Date.now() / 1000) + 14 * 24 * 3600;
    const syncedNames: string[] = [];
    for (const cookie of cookies.values()) {
      // 仅同步 LecSSO 会话 Cookie（_session / _session.sig 等），避免写入 Orbit 专属 _logto 或临时 _interaction
      if (!cookie.value || (cookie.name !== '_session' && !cookie.name.startsWith('_session.'))) {
        continue;
      }
      await ses.cookies
        .set({
          url: cfg.ssoEndpoint,
          name: cookie.name,
          value: cookie.value,
          path: cookie.path || '/',
          secure: cookie.secure ?? secure,
          httpOnly: cookie.httpOnly ?? true,
          sameSite: cookie.sameSite ?? 'lax',
          expirationDate: cookie.expirationDate ?? defaultExp,
        })
        .then(() => syncedNames.push(cookie.name))
        .catch((err) => {
          console.error(`[orbit:auth] failed to sync cookie ${cookie.name}:`, err);
        });
    }
    await ses.cookies.flushStore().catch(() => undefined);
    console.info('[orbit:auth] synced SSO cookies to shared session:', syncedNames.join(', '));
  }

  async signInWithPassword(input: PasswordSignInInput): Promise<SignInStepResult> {
    this.cleanupPendingFlow();
    try {
      const cfg = getOrbitEndpoints();
      const discovery = await this.getDiscovery();
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(64).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const { server, redirectUri, callbackPromise } = await this.createLoopbackCallback(state);

      const flow: PendingExperienceFlow = {
        redirectUri,
        state,
        verifier,
        cookies: new Map(),
        server,
        callbackPromise,
      };
      this.pendingFlow = flow;

      const authUrl = new URL(discovery.authorization_endpoint);
      authUrl.searchParams.set('client_id', cfg.ssoClientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', DEFAULT_SCOPE);
      authUrl.searchParams.set('resource', cfg.punchApiResource);
      authUrl.searchParams.set('organization_id', cfg.ssoOrganizationId);
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      // OIDC Core 1.0：oidc-provider 要求 prompt 含 consent 才保留 offline_access 并签发 refresh_token；
      // 主进程会在 submitExperienceFlow 自动静默完成 /api/interaction/consent，用户侧零跳转。
      authUrl.searchParams.set('prompt', 'login consent');
      authUrl.searchParams.set('state', state);

      await this.experienceRequest(flow, authUrl.toString());

      const initRes = await this.experienceRequest(flow, '/api/experience', {
        method: 'PUT',
        body: { interactionEvent: 'SignIn' },
      });
      if (initRes.status >= 400) {
        return {
          status: 'error',
          message: String(initRes.json.message ?? '无法初始化 LecSSO 登录会话，请尝试内置安全窗登录。'),
          canFallbackWeb: true,
        };
      }

      const identifierValue = input.handle.trim();
      const identifierType = identifierValue.includes('@') ? 'email' : 'username';
      const verifyRes = await this.experienceRequest(flow, '/api/experience/verification/password', {
        method: 'POST',
        body: {
          identifier: { type: identifierType, value: identifierValue },
          password: input.password,
        },
      });
      if (verifyRes.status >= 400 || typeof verifyRes.json.verificationId !== 'string') {
        this.cleanupPendingFlow();
        return {
          status: 'error',
          message: String(verifyRes.json.message ?? '账号或密码错误，请核对 Handle 后重试。'),
          canFallbackWeb: true,
        };
      }

      const identifyRes = await this.experienceRequest(flow, '/api/experience/identification', {
        method: 'POST',
        body: { verificationId: verifyRes.json.verificationId },
      });
      if (identifyRes.status >= 400) {
        this.cleanupPendingFlow();
        return {
          status: 'error',
          message: String(identifyRes.json.message ?? '身份绑定失败，请稍后重试。'),
          canFallbackWeb: true,
        };
      }

      return await this.submitExperienceFlow(flow);
    } catch (err) {
      this.cleanupPendingFlow();
      return {
        status: 'error',
        message: err instanceof Error ? err.message : '登录请求失败，请检查网络连接。',
        canFallbackWeb: true,
      };
    }
  }

  async verifyMfa(input: MfaVerifyInput): Promise<SignInStepResult> {
    const flow = this.pendingFlow;
    if (!flow) {
      return { status: 'error', message: '登录会话已过期，请重新输入账号和密码。', canFallbackWeb: true };
    }
    try {
      const endpoint =
        input.method === 'backup_code'
          ? '/api/experience/verification/backup-code/verify'
          : '/api/experience/verification/totp/verify';
      const verifyRes = await this.experienceRequest(flow, endpoint, {
        method: 'POST',
        body: { code: input.code.trim() },
      });
      if (verifyRes.status >= 400) {
        return {
          status: 'error',
          message: String(verifyRes.json.message ?? '两步验证码无效，请核对后重试。'),
          canFallbackWeb: true,
        };
      }
      return await this.submitExperienceFlow(flow);
    } catch (err) {
      return {
        status: 'error',
        message: err instanceof Error ? err.message : 'MFA 校验失败，请重试。',
        canFallbackWeb: true,
      };
    }
  }

  private async submitExperienceFlow(flow: PendingExperienceFlow): Promise<SignInStepResult> {
    const submitRes = await this.experienceRequest(flow, '/api/experience/submit', {
      method: 'POST',
      body: {},
    });

    if (submitRes.status === 422) {
      const code = String(submitRes.json.code ?? '');
      if (code.includes('mfa') || code.includes('verification')) {
        return {
          status: 'mfa_required',
          methods: ['totp', 'backup_code'],
          message: '此账号已启用两步验证，请输入 6 位动态验证码。',
        };
      }
      this.cleanupPendingFlow();
      return {
        status: 'error',
        message: String(submitRes.json.message ?? '需要补充额外安全校验，请点击下方使用内置安全窗登录。'),
        canFallbackWeb: true,
      };
    }

    const redirectTo = typeof submitRes.json.redirectTo === 'string' ? submitRes.json.redirectTo : null;
    if (submitRes.status >= 400 || !redirectTo) {
      this.cleanupPendingFlow();
      return {
        status: 'error',
        message: String(submitRes.json.message ?? '提交登录失败，请重试或改用内置安全窗登录。'),
        canFallbackWeb: true,
      };
    }

    const cfg = getOrbitEndpoints();
    let nextUrl: string | null = redirectTo;
    let authCode: string | null = null;
    let consented = false;
    for (let step = 0; step < 10 && nextUrl; step += 1) {
      const resolvedUrl = nextUrl.startsWith('http')
        ? nextUrl
        : new URL(nextUrl, cfg.ssoEndpoint).toString();
      if (resolvedUrl.startsWith(flow.redirectUri)) {
        const parsed = new URL(resolvedUrl);
        const oidcError = parsed.searchParams.get('error');
        if (oidcError) {
          throw new Error(
            `LecSSO 授权返回错误：${oidcError}（${parsed.searchParams.get('error_description') ?? ''}）`,
          );
        }
        if (parsed.searchParams.get('state') !== flow.state) {
          throw new Error('OIDC 回调 state 不匹配。');
        }
        authCode = parsed.searchParams.get('code');
        break;
      }

      // 第一方原生应用首次登录触发 /consent 时，在主进程静默完成同源授权确认，全程无弹窗无跳转
      const parsedNext = new URL(resolvedUrl);
      if (parsedNext.pathname.startsWith('/consent') && !consented) {
        consented = true;
        const consentRes = await this.experienceRequest(flow, '/api/interaction/consent', {
          method: 'POST',
          body: { organizationIds: [cfg.ssoOrganizationId] },
        });
        if (consentRes.status < 400 && typeof consentRes.json.redirectTo === 'string') {
          nextUrl = consentRes.json.redirectTo;
          continue;
        }
        console.error('[orbit:auth] auto-consent failed:', consentRes.status, consentRes.json);
        break;
      }

      const hop = await this.experienceRequest(flow, resolvedUrl);
      nextUrl = hop.location;
    }

    if (!authCode) {
      console.error('[orbit:auth] submitExperienceFlow ended without code, last nextUrl=', nextUrl);
      this.cleanupPendingFlow();
      return {
        status: 'error',
        message: '未能自动完成授权回调，请重试或点击下方使用内置安全窗登录。',
        canFallbackWeb: true,
      };
    }

    await this.syncCookiesToSharedSession(flow.cookies);
    await this.exchangeCodeAndPersist(authCode, flow.redirectUri, flow.verifier);
    this.cleanupPendingFlow();
    const auth = this.getState();
    this.emit(auth);
    return { status: 'authenticated', auth };
  }

  async signInWithEmbeddedWindow(parentWindow: BrowserWindow | null): Promise<SignInStepResult> {
    this.cleanupPendingFlow();
    try {
      const cfg = getOrbitEndpoints();
      const discovery = await this.getDiscovery();
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(64).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const { server, redirectUri, callbackPromise } = await this.createLoopbackCallback(state);

      const authUrl = new URL(discovery.authorization_endpoint);
      authUrl.searchParams.set('client_id', cfg.ssoClientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', DEFAULT_SCOPE);
      authUrl.searchParams.set('resource', cfg.punchApiResource);
      authUrl.searchParams.set('organization_id', cfg.ssoOrganizationId);
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('prompt', 'consent');
      authUrl.searchParams.set('state', state);

      const loginWin = new BrowserWindow({
        width: 460,
        height: 660,
        resizable: false,
        modal: Boolean(parentWindow),
        parent: parentWindow ?? undefined,
        title: '登录 LecSSO',
        autoHideMenuBar: true,
        webPreferences: {
          partition: ORBIT_SHARED_PARTITION,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });

      const closedPromise = new Promise<never>((_, reject) => {
        loginWin.on('closed', () => reject(new Error('已取消登录。')));
      });

      void loginWin.loadURL(authUrl.toString());
      try {
        const code = await Promise.race([callbackPromise, closedPromise]);
        await this.getSharedSession().cookies.flushStore().catch(() => undefined);
        if (!loginWin.isDestroyed()) loginWin.close();
        await this.exchangeCodeAndPersist(code, redirectUri, verifier);
        const auth = this.getState();
        this.emit(auth);
        return { status: 'authenticated', auth };
      } finally {
        server.close();
        if (!loginWin.isDestroyed()) loginWin.close();
      }
    } catch (err) {
      return {
        status: 'error',
        message: err instanceof Error ? err.message : '内置窗口登录失败。',
        canFallbackWeb: true,
      };
    }
  }

  private async exchangeCodeAndPersist(
    code: string,
    redirectUri: string,
    verifier: string,
  ): Promise<void> {
    const cfg = getOrbitEndpoints();
    const discovery = await this.getDiscovery();
    // 1. authorization_code 阶段换取 OIDC 基础令牌（opaque access_token + id_token + refresh_token）
    //    organization_id 仅在 refresh_token 换取组织作用域业务 JWT 时传入
    const tokens = await this.requestToken(discovery.token_endpoint, {
      grant_type: 'authorization_code',
      client_id: cfg.ssoClientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });

    if (tokens.refresh_token) {
      this.secrets.setRefreshToken(REFRESH_SECRET_KEY, tokens.refresh_token);
    } else {
      console.error('[orbit:auth] authorization_code response missing refresh_token!');
    }

    const expiresAt = Date.now() + Math.max(60, tokens.expires_in - 60) * 1000;
    this.tokenCache.set('orbit', { accessToken: tokens.access_token, expiresAt });

    const idClaims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : {};
    this.profile = {
      issuer: String(idClaims.iss ?? discovery.issuer),
      subject: String(idClaims.sub ?? ''),
      username: typeof idClaims.username === 'string' ? idClaims.username : undefined,
      name: typeof idClaims.name === 'string' ? idClaims.name : undefined,
      avatar: typeof idClaims.picture === 'string' ? idClaims.picture : undefined,
      organizations: Array.isArray(idClaims.organizations)
        ? idClaims.organizations.map(String)
        : [cfg.ssoOrganizationId],
      organizationRoles: Array.isArray(idClaims.organization_roles)
        ? idClaims.organization_roles.map(String)
        : [],
    };
    this.persistProfile(this.profile);
    await this.refreshUserProfile(tokens.access_token).catch(() => undefined);
    // 2. 预热 LecPunch 组织级 API JWT（resource + organization_id）
    const punchToken = await this.getApiToken('punch').catch((err) => {
      console.error('[orbit:auth] prefetch punch token failed:', err);
      return null;
    });
    console.info(
      `[orbit:auth] sign-in persisted: hasRefreshToken=${Boolean(tokens.refresh_token)} hasPunchToken=${Boolean(punchToken)}`,
    );
  }

  private async refreshUserProfile(accessToken: string): Promise<void> {
    const discovery = await this.getDiscovery();
    if (!discovery.userinfo_endpoint) return;
    const res = await fetch(discovery.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return;
    const data = (await res.json()) as Record<string, unknown>;
    const cfg = getOrbitEndpoints();
    this.profile = {
      issuer: this.profile?.issuer ?? discovery.issuer,
      subject: String(data.sub ?? this.profile?.subject ?? ''),
      username: typeof data.username === 'string' ? data.username : this.profile?.username,
      name: typeof data.name === 'string' ? data.name : this.profile?.name,
      avatar: typeof data.picture === 'string' ? data.picture : this.profile?.avatar,
      organizations: Array.isArray(data.organizations)
        ? data.organizations.map(String)
        : this.profile?.organizations ?? [cfg.ssoOrganizationId],
      organizationRoles: Array.isArray(data.organization_roles)
        ? data.organization_roles.map(String)
        : this.profile?.organizationRoles ?? [],
    };
    this.persistProfile(this.profile);
  }

  private async requestToken(
    tokenEndpoint: string,
    params: Record<string, string>,
  ): Promise<TokenResponse> {
    const body = new URLSearchParams(params);
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(
        `换取 LecSSO Token 失败（HTTP ${res.status}）${detail ? `：${detail.slice(0, 160)}` : ''}`,
      ) as Error & { status?: number; isInvalidGrant?: boolean };
      err.status = res.status;
      err.isInvalidGrant = res.status === 400 && detail.includes('invalid_grant');
      throw err;
    }
    return (await res.json()) as TokenResponse;
  }

  async getApiToken(
    target: 'punch' | 'orbit',
    options?: { forceRefresh?: boolean },
  ): Promise<string | null> {
    const cached = this.tokenCache.get(target);
    if (!options?.forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.accessToken;
    }

    const run = async (): Promise<string | null> => {
      // 进入串行锁后再次查缓存，避免并发请求重复消费同一个轮换中的 refresh_token
      const rechecked = this.tokenCache.get(target);
      if (!options?.forceRefresh && rechecked && rechecked.expiresAt > Date.now()) {
        return rechecked.accessToken;
      }

      const refreshToken = this.secrets.getRefreshToken(REFRESH_SECRET_KEY);
      if (!refreshToken) return null;

      try {
        const cfg = getOrbitEndpoints();
        const discovery = await this.getDiscovery();
        const params: Record<string, string> = {
          grant_type: 'refresh_token',
          client_id: cfg.ssoClientId,
          refresh_token: refreshToken,
        };
        if (target === 'punch') {
          params.resource = cfg.punchApiResource;
          params.organization_id = cfg.ssoOrganizationId;
        }
        const tokens = await this.requestToken(discovery.token_endpoint, params);
        if (tokens.refresh_token) {
          this.secrets.setRefreshToken(REFRESH_SECRET_KEY, tokens.refresh_token);
        }
        const expiresAt = Date.now() + Math.max(60, tokens.expires_in - 60) * 1000;
        this.tokenCache.set(target, { accessToken: tokens.access_token, expiresAt });
        if (target === 'punch') {
          const isJwt = tokens.access_token.split('.').length === 3;
          const claims = isJwt ? decodeJwtPayload(tokens.access_token) : {};
          console.info('[orbit:auth] minted punch token metadata:', {
            isJwt,
            aud: claims.aud,
            iss: claims.iss,
            orgId: claims.organization_id,
            scope: claims.scope,
            claimKeys: Object.keys(claims),
          });
        }
        return tokens.access_token;
      } catch (err) {
        const typed = err as { isInvalidGrant?: boolean };
        console.error(`[orbit:auth] getApiToken(${target}) failed:`, err);
        // 仅在 LecSSO 明确返回 invalid_grant（令牌确实过期/被撤销）时才清理登录态；网络抖动或断网绝不清除 refresh_token
        if (typed.isInvalidGrant) {
          this.secrets.deleteRefreshToken(REFRESH_SECRET_KEY);
          this.tokenCache.clear();
          this.profile = null;
          this.persistProfile(null);
          this.emit(this.getState());
        }
        return null;
      }
    };

    const next = this.refreshChain.then(run, run);
    this.refreshChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async fetchApproveChallenge(challengeId: string): Promise<OrbitChallengeDetail> {
    const token = await this.getApiToken('orbit');
    if (!token) {
      throw new Error('请先在 Orbit 完成 LecSSO 登录，再批准外部浏览器登录请求。');
    }
    const cfg = getOrbitEndpoints();
    const res = await fetch(
      `${cfg.ssoEndpoint}/api/lec/orbit-auth/challenges/${encodeURIComponent(challengeId)}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`无法读取授权请求（HTTP ${res.status}）${detail ? `：${detail.slice(0, 120)}` : ''}`);
    }
    return (await res.json()) as OrbitChallengeDetail;
  }

  async submitApproveDecision(
    challengeId: string,
    action: 'approve' | 'deny',
  ): Promise<OrbitChallengeDetail> {
    const token = await this.getApiToken('orbit');
    if (!token) {
      throw new Error('登录状态已失效，请重新登录 Orbit。');
    }
    const cfg = getOrbitEndpoints();
    const res = await fetch(
      `${cfg.ssoEndpoint}/api/lec/orbit-auth/challenges/${encodeURIComponent(challengeId)}/decision`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ action }),
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`提交授权决定失败（HTTP ${res.status}）${detail ? `：${detail.slice(0, 120)}` : ''}`);
    }
    return (await res.json()) as OrbitChallengeDetail;
  }

  private async extractLogtoErrorMessage(res: Response, fallback: string): Promise<string> {
    try {
      const payload = (await res.json()) as { code?: string; message?: string };
      if (payload.code === 'session.invalid_credentials') {
        return '当前密码不正确，请核对后重试。';
      }
      if (payload.code === 'account_center.not_enabled' || payload.code === 'account_center.field_not_editable') {
        return 'LecSSO 账户中心暂未开放该字段编辑权限，请联系管理员开启。';
      }
      if (payload.code === 'storage.not_configured') {
        return 'LecSSO 暂未配置头像存储服务，可改用 HTTPS 头像链接。';
      }
      if (payload.code === 'guard.file_size_exceeded') {
        return '图片体积超过限制，请选择 10MB 以内的图片。';
      }
      if (payload.code === 'guard.mime_type_not_allowed') {
        return '仅支持 PNG / JPG / WEBP / GIF / BMP 格式图片。';
      }
      if (payload.message) return payload.message;
    } catch {
      // 忽略非 JSON 响应
    }
    return `${fallback}（HTTP ${res.status}）`;
  }

  /** 复用 Logto Account API：上传本地头像到 /api/my-account/user-assets/avatar 并写回 /api/my-account。 */
  async uploadAvatarFromFile(filePath: string): Promise<AccountActionResult> {
    const token = await this.getApiToken('orbit');
    if (!token) {
      return { ok: false, message: '登录状态已失效，请重新登录 LecSSO。' };
    }
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 10 * 1024 * 1024) {
        return { ok: false, message: '头像图片不能超过 10MB，请压缩后再上传。' };
      }
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
      };
      const mimeType = mimeMap[ext];
      if (!mimeType) {
        return { ok: false, message: '仅支持 PNG / JPG / WEBP / GIF / BMP 格式的图片。' };
      }
      const buf = await fs.readFile(filePath);
      const form = new FormData();
      form.append('file', new Blob([buf], { type: mimeType }), path.basename(filePath));

      const cfg = getOrbitEndpoints();
      const uploadRes = await fetch(`${cfg.ssoEndpoint}/api/my-account/user-assets/avatar`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        body: form,
      });
      if (!uploadRes.ok) {
        return {
          ok: false,
          message: await this.extractLogtoErrorMessage(uploadRes, '上传头像失败'),
        };
      }
      const uploaded = (await uploadRes.json()) as { url?: string };
      if (!uploaded.url) {
        return { ok: false, message: 'LecSSO 未返回有效的头像地址。' };
      }
      return await this.updateAvatarUrl(uploaded.url);
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : '读取或上传头像文件失败。',
      };
    }
  }

  /** 复用 Logto Account API：PATCH /api/my-account 更新头像并同步本地与业务 JWT 缓存。 */
  async updateAvatarUrl(avatarUrl: string | null): Promise<AccountActionResult> {
    const token = await this.getApiToken('orbit');
    if (!token) {
      return { ok: false, message: '登录状态已失效，请重新登录 LecSSO。' };
    }
    try {
      const cfg = getOrbitEndpoints();
      const res = await fetch(`${cfg.ssoEndpoint}/api/my-account`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ avatar: avatarUrl }),
      });
      if (!res.ok) {
        return {
          ok: false,
          message: await this.extractLogtoErrorMessage(res, '更新头像失败'),
        };
      }
      if (this.profile) {
        this.profile = {
          ...this.profile,
          avatar: avatarUrl ?? undefined,
        };
        this.persistProfile(this.profile);
      }
      // 失效旧 Punch JWT，使后续考勤/周榜刷新拿到最新头像 claim
      this.tokenCache.delete('punch');
      const auth = this.getState();
      this.emit(auth);
      return { ok: true, auth, message: avatarUrl ? '头像已更新并同步至 LecSSO。' : '已恢复默认头像。' };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : '更新头像失败，请检查网络连接。',
      };
    }
  }

  /** 复用 Logto Account API 两步改密：POST /api/verifications/password -> POST /api/my-account/password。 */
  async changePassword(input: ChangePasswordInput): Promise<AccountActionResult> {
    const token = await this.getApiToken('orbit');
    if (!token) {
      return { ok: false, message: '登录状态已失效，请重新登录 LecSSO。' };
    }
    try {
      const cfg = getOrbitEndpoints();
      const verifyRes = await fetch(`${cfg.ssoEndpoint}/api/verifications/password`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ password: input.currentPassword }),
      });
      if (!verifyRes.ok) {
        return {
          ok: false,
          message: await this.extractLogtoErrorMessage(verifyRes, '校验当前密码失败'),
        };
      }
      const { verificationRecordId } = (await verifyRes.json()) as { verificationRecordId?: string };
      if (!verificationRecordId) {
        return { ok: false, message: '未能获取 LecSSO 身份校验凭据，请重试。' };
      }

      const updateRes = await fetch(`${cfg.ssoEndpoint}/api/my-account/password`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'logto-verification-id': verificationRecordId,
        },
        body: JSON.stringify({ password: input.newPassword }),
      });
      if (!updateRes.ok) {
        return {
          ok: false,
          message: await this.extractLogtoErrorMessage(updateRes, '修改密码失败'),
        };
      }
      return { ok: true, message: '密码修改成功，已同步至 LecSSO 统一身份中心。' };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : '修改密码失败，请检查网络连接。',
      };
    }
  }

  async signOut(): Promise<AuthState> {
    this.cleanupPendingFlow();
    const refreshToken = this.secrets.getRefreshToken(REFRESH_SECRET_KEY);
    this.secrets.deleteRefreshToken(REFRESH_SECRET_KEY);
    this.tokenCache.clear();
    this.profile = null;
    this.persistProfile(null);
    if (refreshToken) {
      try {
        const cfg = getOrbitEndpoints();
        const discovery = await this.getDiscovery();
        if (discovery.revocation_endpoint) {
          await fetch(discovery.revocation_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: cfg.ssoClientId,
              token: refreshToken,
            }).toString(),
          });
        }
      } catch {
        // 撤销失败不阻塞本地登出
      }
    }
    await this.getSharedSession().clearStorageData({ storages: ['cookies'] }).catch(() => undefined);
    const state = this.getState();
    this.emit(state);
    return state;
  }
}
