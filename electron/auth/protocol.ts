/**
 * 解析 lec-orbit:// 自定义协议深链（Stage 2 全机 LecSSO 弹窗唤醒入口）。
 * 严格校验协议、路径与 challengeId 格式，防止恶意协议注入。
 */
export interface ParsedOrbitProtocolUrl {
  action: 'approve-auth';
  challengeId: string;
}

const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function parseOrbitProtocolUrl(rawUrl: string): ParsedOrbitProtocolUrl | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'lec-orbit:') return null;
    const host = parsed.hostname.toLowerCase();
    const cleanPath = parsed.pathname.replace(/^\/+/, '').toLowerCase();
    const isAuthApprove =
      host === 'auth' ||
      host === 'approve' ||
      (host === '' && (cleanPath === 'auth' || cleanPath === 'approve'));
    if (!isAuthApprove) return null;

    const challengeId = parsed.searchParams.get('c') ?? parsed.searchParams.get('challenge') ?? '';
    if (!CHALLENGE_PATTERN.test(challengeId)) return null;
    return { action: 'approve-auth', challengeId };
  } catch {
    return null;
  }
}
