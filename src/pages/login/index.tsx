/** Orbit 登录弹窗：原生账号密码登录，内置 MFA 两步验证，以及 GitHub / 飞书 / 注册外部默认浏览器直达登录。 */
import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import { Button, Dialog, Input, Message } from '@lec-space/liquidglass';
import { User } from '@lec-space/icons';
import { X } from 'lucide-react';
import { SocialBrandGlyph } from '@/components/SocialBrandGlyph';
import { getOrbitClient } from '@/services/orbitClient';
import { notifyToast } from '@/services/orbitToast';
import { useOrbitStore } from '@/stores/useOrbitStore';
import styles from './LoginModal.module.css';

export interface LoginModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type ExternalSignInTarget = 'github' | 'feishu' | 'register';

const EXTERNAL_WAIT_COPY: Record<ExternalSignInTarget, string> = {
  github: '已在默认浏览器打开 GitHub 授权页，完成授权后将自动返回 Orbit…',
  feishu: '已在默认浏览器打开飞书授权页，完成授权后将自动返回 Orbit…',
  register: '已在默认浏览器打开注册页，完成注册后将自动返回 Orbit…',
};

export function LoginModal({ open, onOpenChange }: LoginModalProps): JSX.Element {
  const setAuthState = useOrbitStore((s) => s.setAuthState);
  const lastLoginHandle = useOrbitStore((s) => s.config.lastLoginHandle);

  const [step, setStep] = useState<'password' | 'mfa'>('password');
  const [handle, setHandle] = useState(() => lastLoginHandle ?? '');
  const [password, setPassword] = useState('');
  const [mfaMethod, setMfaMethod] = useState<'totp' | 'backup_code'>('totp');
  const [mfaCode, setMfaCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [waitingTarget, setWaitingTarget] = useState<ExternalSignInTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 递增外部登录请求序号，防止取消后快速切换平台时旧请求返回误清当前等待态。 */
  const externalRequestIdRef = useRef(0);

  const waitingBrowser = waitingTarget !== null;

  useEffect(() => {
    if (open && !handle && lastLoginHandle) {
      setHandle(lastLoginHandle);
    }
    if (!open && waitingBrowser) {
      externalRequestIdRef.current += 1;
      setWaitingTarget(null);
      setSubmitting(false);
      void getOrbitClient().auth.cancelExternalSignIn();
    }
  }, [open, handle, lastLoginHandle, waitingBrowser]);

  const handlePasswordSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!handle.trim() || !password) {
      setError('请输入账号与密码。');
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await getOrbitClient().auth.signInWithPassword({ handle: handle.trim(), password });
    setSubmitting(false);

    if (res.status === 'authenticated') {
      setPassword('');
      setAuthState(res.auth);
      onOpenChange(false);
      notifyToast({
        tone: 'success',
        title: '登录成功',
        description: `欢迎回来，${res.auth.profile?.name || res.auth.profile?.username || '伙伴'}`,
      });
      return;
    }
    if (res.status === 'mfa_required') {
      setStep('mfa');
      setMfaCode('');
      setError(null);
      return;
    }
    setError(res.message);
  };

  const handleMfaSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!mfaCode.trim()) {
      setError('请输入两步验证码。');
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await getOrbitClient().auth.verifyMfa({ method: mfaMethod, code: mfaCode.trim() });
    setSubmitting(false);

    if (res.status === 'authenticated') {
      setPassword('');
      setMfaCode('');
      setStep('password');
      setAuthState(res.auth);
      onOpenChange(false);
      notifyToast({
        tone: 'success',
        title: '登录成功',
        description: `欢迎回来，${res.auth.profile?.name || res.auth.profile?.username || '伙伴'}`,
      });
      return;
    }
    setError(res.message);
  };

  const handleExternalSignIn = async (target: ExternalSignInTarget) => {
    const requestId = ++externalRequestIdRef.current;
    setWaitingTarget(target);
    setSubmitting(true);
    setError(null);
    const options =
      target === 'register' ? { firstScreen: 'register' as const } : { provider: target };
    const res = await getOrbitClient().auth.signInWithEmbeddedWindow(options);
    if (externalRequestIdRef.current !== requestId) {
      return;
    }
    setWaitingTarget(null);
    setSubmitting(false);
    if (res.status === 'authenticated') {
      setAuthState(res.auth);
      onOpenChange(false);
      notifyToast({
        tone: 'success',
        title: '登录成功',
        description: `欢迎回来，${res.auth.profile?.name || res.auth.profile?.username || '伙伴'}`,
      });
      return;
    }
    if (res.status === 'error' && res.message !== '已取消浏览器登录。') {
      setError(res.message);
    }
  };

  const handleCancelBrowserSignIn = () => {
    externalRequestIdRef.current += 1;
    setWaitingTarget(null);
    setSubmitting(false);
    void getOrbitClient().auth.cancelExternalSignIn();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && waitingBrowser) {
          handleCancelBrowserSignIn();
        }
        onOpenChange(nextOpen);
      }}
      size="small"
      title={
        <div className={styles.titleRow}>
          <img src="./icon.png" alt="" width={24} height={24} style={{ display: 'block', borderRadius: 6 }} />
          <span>登录 Orbit</span>
        </div>
      }
    >
      {step === 'password' ? (
        <form className={styles.form} onSubmit={handlePasswordSubmit}>
          <label className={styles.field}>
            <span className={styles.label}>账号</span>
            <Input
              variant="fill"
              icon={<User size={16} />}
              placeholder="用户名或邮箱"
              value={handle}
              onValueChange={setHandle}
              autoComplete="username"
              disabled={submitting}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>密码</span>
            <Input
              variant="fill"
              type="password"
              placeholder="输入密码"
              value={password}
              onValueChange={setPassword}
              autoComplete="current-password"
              disabled={submitting}
            />
          </label>
          {error && <Message tone="error">{error}</Message>}
          {waitingTarget && (
            <div className={styles.browserWaitBox}>
              <span>{EXTERNAL_WAIT_COPY[waitingTarget]}</span>
              <Button
                variant="glass"
                size="small"
                type="button"
                icon={<X size={13} />}
                onClick={handleCancelBrowserSignIn}
              >
                取消
              </Button>
            </div>
          )}
          <div className={styles.actions}>
            <Button
              variant="filled"
              type="submit"
              loading={submitting && !waitingBrowser}
              disabled={waitingBrowser}
              className={styles.primaryBtn}
            >
              登录
            </Button>
            <div className={styles.dividerRow}>
              <span className={styles.dividerLine} />
              <span className={styles.dividerText}>其他登录方式</span>
              <span className={styles.dividerLine} />
            </div>
            <div className={styles.socialBtnRow}>
              <Button
                variant="glass"
                type="button"
                icon={<SocialBrandGlyph target="github" size={17} />}
                loading={waitingTarget === 'github'}
                disabled={submitting && waitingTarget !== 'github'}
                className={styles.socialBtn}
                onClick={() => void handleExternalSignIn('github')}
              >
                GitHub
              </Button>
              <Button
                variant="glass"
                type="button"
                icon={<SocialBrandGlyph target="feishu" size={17} />}
                loading={waitingTarget === 'feishu'}
                disabled={submitting && waitingTarget !== 'feishu'}
                className={styles.socialBtn}
                onClick={() => void handleExternalSignIn('feishu')}
              >
                飞书
              </Button>
            </div>
            <div className={styles.footerRow}>
              <span className={styles.footerHint}>还没有账号？</span>
              <button
                type="button"
                className={styles.fallbackLink}
                disabled={submitting}
                onClick={() => void handleExternalSignIn('register')}
              >
                {waitingTarget === 'register' ? '等待浏览器注册完成…' : '浏览器注册'}
              </button>
            </div>
          </div>
        </form>
      ) : (
        <form className={styles.form} onSubmit={handleMfaSubmit}>
          <p className={styles.mfaBanner}>请输入身份验证器中的 6 位动态码，或改用备用恢复码。</p>
          <label className={styles.field}>
            <span className={styles.label}>
              {mfaMethod === 'totp' ? '6 位 TOTP 验证码' : '备用恢复码'}
            </span>
            <Input
              variant="fill"
              placeholder={mfaMethod === 'totp' ? '123456' : '输入备用恢复码'}
              value={mfaCode}
              onValueChange={setMfaCode}
              disabled={submitting}
            />
          </label>
          {error && <Message tone="error">{error}</Message>}
          <div className={styles.actions}>
            <Button variant="filled" type="submit" loading={submitting} className={styles.primaryBtn}>
              验证并完成登录
            </Button>
            <div className={styles.secondaryRow}>
              <Button
                variant="glass"
                size="small"
                type="button"
                onClick={() => setMfaMethod((m) => (m === 'totp' ? 'backup_code' : 'totp'))}
              >
                {mfaMethod === 'totp' ? '改用备用码' : '改用 TOTP 动态码'}
              </Button>
              <Button
                variant="glass"
                size="small"
                type="button"
                onClick={() => {
                  setStep('password');
                  setError(null);
                }}
              >
                返回上一步
              </Button>
            </div>
          </div>
        </form>
      )}
    </Dialog>
  );
}
