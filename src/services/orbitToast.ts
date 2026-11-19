/** Orbit 全局 Liquid Glass Toast 桥接：统一展示接口报错、操作结果与带动作按钮的轻提示。 */
import type { ToastApi, ToastOptions } from '@lec-space/liquidglass';

let toastApi: ToastApi | null = null;
const recentFingerprints = new Map<string, number>();

export function registerOrbitToast(api: ToastApi | null): void {
  toastApi = api;
}

/** 发送全局 Liquid Glass Toast，3 秒内自动去重相同标题与描述，避免并发接口刷屏。 */
export function notifyToast(options: ToastOptions): void {
  if (!toastApi) return;
  const key = `${options.tone ?? 'info'}::${options.title}::${options.description ?? ''}`;
  const now = Date.now();
  const last = recentFingerprints.get(key) ?? 0;
  if (now - last < 3000) return;
  recentFingerprints.set(key, now);
  toastApi.toast(options);
}
