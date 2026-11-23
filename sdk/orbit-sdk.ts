/**
 * @lec-space/orbit-sdk（v1.0.0）
 * 面向 Orbit 工坊小程序（React/Vue/Vanilla）与 Cocos Creator 3.x 的标准 TypeScript SDK。
 * 在 Orbit 容器外（例如普通浏览器预览）自动提供本地 localStorage 降级实现。
 */

export type OrbitTheme = 'light' | 'dark';
export type OrbitDisplayMode = 'sidepanel' | 'workspace' | 'standalone';

export interface OrbitUserProfile {
  userId: string;
  username?: string;
  displayName: string;
  avatar?: string;
  isAdmin: boolean;
}

export interface OrbitEnvInfo {
  appId: string;
  name: string;
  version: string;
  mode: OrbitDisplayMode;
  platform: string;
  theme: OrbitTheme;
  crossOriginIsolated: boolean;
  orbitVersion: string;
}

export interface OrbitSDK {
  sdkVersion: '1.0.0';
  isOrbit: boolean;
  env: {
    getInfo: () => Promise<OrbitEnvInfo>;
    getTheme: () => Promise<OrbitTheme>;
    onThemeChange: (listener: (theme: OrbitTheme) => void) => () => void;
    onModeChange: (listener: (mode: OrbitDisplayMode) => void) => () => void;
  };
  user: {
    getCurrent: () => Promise<OrbitUserProfile | null>;
  };
  storage: {
    get: <T = unknown>(key: string) => Promise<T | null>;
    set: (key: string, value: unknown) => Promise<void>;
    remove: (key: string) => Promise<void>;
    keys: () => Promise<string[]>;
  };
  ui: {
    toast: (message: string, tone?: 'info' | 'success' | 'warning' | 'error') => Promise<void>;
    requestMode: (mode: OrbitDisplayMode) => Promise<boolean>;
  };
  clipboard: {
    writeText: (text: string) => Promise<void>;
  };
  lifecycle: {
    onPause: (listener: () => void) => () => void;
    onResume: (listener: () => void) => () => void;
  };
}

declare global {
  interface Window {
    orbitSDK?: OrbitSDK;
  }
}

const FALLBACK_PREFIX = 'orbit-sdk-dev-kv:';

function createBrowserFallbackSDK(): OrbitSDK {
  const prefersDark = () =>
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';

  return {
    sdkVersion: '1.0.0',
    isOrbit: false,
    env: {
      getInfo: async () => ({
        appId: 'browser-dev',
        name: document.title || 'Browser Preview',
        version: '0.0.0-dev',
        mode: 'standalone',
        platform: navigator.platform || 'web',
        theme: prefersDark(),
        crossOriginIsolated: Boolean(window.crossOriginIsolated),
        orbitVersion: '0.0.0',
      }),
      getTheme: async () => prefersDark(),
      onThemeChange: (listener) => {
        const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
        if (!mq) return () => undefined;
        const onChange = () => listener(mq.matches ? 'dark' : 'light');
        mq.addEventListener?.('change', onChange);
        return () => mq.removeEventListener?.('change', onChange);
      },
      onModeChange: () => () => undefined,
    },
    user: {
      getCurrent: async () => ({
        userId: 'dev-local-user',
        username: 'dev',
        displayName: '本地调试开发者',
        isAdmin: true,
      }),
    },
    storage: {
      get: async <T = unknown>(key: string) => {
        const raw = window.localStorage.getItem(FALLBACK_PREFIX + key);
        if (raw == null) return null;
        try {
          return JSON.parse(raw) as T;
        } catch {
          return raw as unknown as T;
        }
      },
      set: async (key: string, value: unknown) => {
        window.localStorage.setItem(FALLBACK_PREFIX + key, JSON.stringify(value));
      },
      remove: async (key: string) => {
        window.localStorage.removeItem(FALLBACK_PREFIX + key);
      },
      keys: async () => {
        const out: string[] = [];
        for (let i = 0; i < window.localStorage.length; i += 1) {
          const k = window.localStorage.key(i);
          if (k && k.startsWith(FALLBACK_PREFIX)) {
            out.push(k.slice(FALLBACK_PREFIX.length));
          }
        }
        return out.sort();
      },
    },
    ui: {
      toast: async (message) => {
        console.info('[orbit-sdk:toast]', message);
      },
      requestMode: async () => false,
    },
    clipboard: {
      writeText: async (text) => {
        await navigator.clipboard?.writeText(text);
      },
    },
    lifecycle: {
      onPause: () => () => undefined,
      onResume: () => () => undefined,
    },
  };
}

let cachedFallback: OrbitSDK | null = null;

export function getOrbitSDK(): OrbitSDK {
  if (typeof window !== 'undefined' && window.orbitSDK) {
    return window.orbitSDK;
  }
  if (!cachedFallback) {
    cachedFallback = createBrowserFallbackSDK();
  }
  return cachedFallback;
}
