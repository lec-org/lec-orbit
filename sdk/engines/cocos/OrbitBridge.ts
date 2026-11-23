/**
 * Cocos Creator 3.8 适配器（直接复制到 assets/scripts/OrbitBridge.ts 即可使用）。
 * 构建平台推荐选择 Web Desktop 或 Web Mobile，并在构建产物根目录放入 orbit.manifest.json。
 */
import { getOrbitSDK, type OrbitDisplayMode, type OrbitTheme, type OrbitUserProfile } from '../../orbit-sdk';

export class CocosOrbitBridge {
  static get isOrbit(): boolean {
    return getOrbitSDK().isOrbit;
  }

  static async getUser(): Promise<OrbitUserProfile | null> {
    return getOrbitSDK().user.getCurrent();
  }

  static async getTheme(): Promise<OrbitTheme> {
    return getOrbitSDK().env.getTheme();
  }

  static onThemeChange(cb: (theme: OrbitTheme) => void): () => void {
    return getOrbitSDK().env.onThemeChange(cb);
  }

  static onModeChange(cb: (mode: OrbitDisplayMode) => void): () => void {
    return getOrbitSDK().env.onModeChange(cb);
  }

  static async saveData(key: string, value: unknown): Promise<void> {
    return getOrbitSDK().storage.set(key, value);
  }

  static async loadData<T = unknown>(key: string): Promise<T | null> {
    return getOrbitSDK().storage.get<T>(key);
  }

  static toast(message: string, tone: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    void getOrbitSDK().ui.toast(message, tone);
  }
}
