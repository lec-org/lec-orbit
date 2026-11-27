/** 偏好设置页：账号与身份管理（复用 Logto Account API 换头像与改密码）、外观主题、托盘与缓存更新。 */
import { useState, type FormEvent, type JSX } from 'react';
import {
  Avatar,
  Button,
  Card,
  Dialog,
  Input,
  Message,
  SegmentedControl,
  Switch,
  Tag,
} from '@lec-space/liquidglass';
import {
  Download,
  LogOut,
  RefreshCw,
  Trash2,
  Upload,
} from '@lec-space/icons';
import { Camera, KeyRound, Sparkles } from 'lucide-react';
import { getOrbitEndpoints } from '@shared/env';
import type { ThemePreference } from '@shared/ipc';
import { UpdateChangelogDialog } from '@/components/UpdateChangelogDialog';
import { getOrbitClient } from '@/services/orbitClient';
import { notifyToast } from '@/services/orbitToast';
import { useOrbitStore } from '@/stores/useOrbitStore';
import { SocialBindingsCard } from './SocialBindingsCard';
import { WifiFingerprintCard } from './WifiFingerprintCard';
import { DutyScheduleCard } from './DutyScheduleCard';
import { hasStudioRole } from '@shared/studioRole';
import styles from './Settings.module.css';

export function SettingsPage(): JSX.Element {
  const auth = useOrbitStore((s) => s.auth);
  const config = useOrbitStore((s) => s.config);
  const feverThreshold = useOrbitStore((s) => s.feverThreshold);
  const updateConfig = useOrbitStore((s) => s.updateConfig);
  const setAuthState = useOrbitStore((s) => s.setAuthState);
  const setLoginModalOpen = useOrbitStore((s) => s.setLoginModalOpen);

  const updateInfo = useOrbitStore((s) => s.updateInfo);
  const setUpdateInfo = useOrbitStore((s) => s.setUpdateInfo);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [changelogDialogOpen, setChangelogDialogOpen] = useState(false);

  // 更换头像弹窗状态
  const [avatarDialogOpen, setAvatarDialogOpen] = useState(false);
  const [avatarUrlInput, setAvatarUrlInput] = useState('');
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  // 修改密码弹窗状态
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const openAvatarDialog = () => {
    setAvatarUrlInput(auth.profile?.avatar ?? '');
    setAvatarError(null);
    setAvatarDialogOpen(true);
  };

  const openPasswordDialog = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setPasswordError(null);
    setPasswordDialogOpen(true);
  };

  const handleUploadLocalAvatar = async () => {
    setAvatarBusy(true);
    setAvatarError(null);
    const res = await getOrbitClient().auth.pickAndUploadAvatar();
    setAvatarBusy(false);
    if (res.cancelled) return;
    if (res.ok) {
      if (res.auth) setAuthState(res.auth);
      setAvatarDialogOpen(false);
      notifyToast({
        tone: 'success',
        title: '头像已更新',
        description: res.message || '新头像已同步至 LecSSO 统一身份中心。',
      });
      return;
    }
    setAvatarError(res.message || '上传头像失败，请重试。');
  };

  const handleSaveAvatarUrl = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = avatarUrlInput.trim();
    if (!trimmed) {
      setAvatarError('请输入有效的 HTTP/HTTPS 图片链接，或直接点击上方上传本地图片。');
      return;
    }
    setAvatarBusy(true);
    setAvatarError(null);
    const res = await getOrbitClient().auth.updateAvatarUrl({ avatarUrl: trimmed });
    setAvatarBusy(false);
    if (res.ok) {
      if (res.auth) setAuthState(res.auth);
      setAvatarDialogOpen(false);
      notifyToast({
        tone: 'success',
        title: '头像已更新',
        description: res.message || '新头像已同步至 LecSSO 统一身份中心。',
      });
      return;
    }
    setAvatarError(res.message || '更新头像链接失败。');
  };

  const handleClearAvatar = async () => {
    setAvatarBusy(true);
    setAvatarError(null);
    const res = await getOrbitClient().auth.updateAvatarUrl({ avatarUrl: null });
    setAvatarBusy(false);
    if (res.ok) {
      if (res.auth) setAuthState(res.auth);
      setAvatarDialogOpen(false);
      notifyToast({
        tone: 'info',
        title: '已恢复默认头像',
        description: 'LecSSO 头像已清空，将显示姓名首字头像。',
      });
      return;
    }
    setAvatarError(res.message || '清空头像失败。');
  };

  const handleChangePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!currentPassword) {
      setPasswordError('请输入当前密码。');
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError('新密码长度至少 8 位。');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('两次输入的新密码不一致，请重新确认。');
      return;
    }
    if (newPassword === currentPassword) {
      setPasswordError('新密码不能与当前密码相同。');
      return;
    }
    setPasswordBusy(true);
    setPasswordError(null);
    const res = await getOrbitClient().auth.changePassword({ currentPassword, newPassword });
    setPasswordBusy(false);
    if (res.ok) {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordDialogOpen(false);
      notifyToast({
        tone: 'success',
        title: '密码已修改',
        description: res.message || '新密码已同步至 LecSSO 统一身份中心。',
      });
      return;
    }
    setPasswordError(res.message || '修改密码失败，请核对当前密码与密码复杂度要求。');
  };

  const handleSignOut = async () => {
    const next = await getOrbitClient().auth.signOut();
    setAuthState(next);
    notifyToast({ tone: 'info', title: '已退出 LecSSO 登录' });
  };

  const handleClearCache = async () => {
    await getOrbitClient().storage.clearUserCache();
    notifyToast({
      tone: 'success',
      title: '本地缓存已清理',
      description: '已清空接口缓存与文档访问记录，周报草稿保持完好。',
    });
  };

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const res = await getOrbitClient().system.checkUpdate();
      setUpdateInfo(res);
      if (res.stage === 'error') {
        notifyToast({
          tone: 'error',
          title: '检查更新失败',
          description: '无法连接更新源，请检查网络后稍后重试。',
        });
      } else if (res.available) {
        notifyToast({
          tone: 'info',
          title: `发现新版本 v${res.latestVersion}`,
          description: '可在下方点击下载并在完成后重启安装。',
        });
      } else {
        notifyToast({
          tone: 'success',
          title: '已是最新版本',
          description: `当前版本 v${res.currentVersion}`,
        });
      }
    } finally {
      setCheckingUpdate(false);
    }
  };

  const endpoints = getOrbitEndpoints();
  const displayName = auth.profile?.name || auth.profile?.username || '未登录';

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.heading}>设置</h1>
        <p className={styles.subheading}>账号与身份、外观主题、系统托盘行为与本地存储管理</p>
      </header>

      <Card title="账号与身份（LecSSO）">
        <div className={styles.accountRow}>
          <div className={styles.accountLeft}>
            {auth.authenticated ? (
              <button
                type="button"
                className={styles.avatarButton}
                title="点击更换头像"
                onClick={openAvatarDialog}
              >
                <Avatar src={auth.profile?.avatar} name={displayName} size="large" />
                <span className={styles.avatarBadge} aria-hidden="true">
                  <Camera size={12} />
                </span>
              </button>
            ) : (
              <Avatar name="未登录" size="large" />
            )}
            <div>
              <div className={styles.accountName}>
                {auth.authenticated ? displayName : '尚未登录'}
              </div>
              <div className={styles.accountMeta}>
                {auth.authenticated
                  ? `${auth.profile?.username ?? auth.profile?.subject ?? ''} · ${
                      auth.isStudioMember ? 'lec-studio 正式成员' : '外部账号 / Applicant'
                    }`
                  : `身份中心：${endpoints.ssoEndpoint}`}
              </div>
            </div>
          </div>
          {auth.authenticated ? (
            <div className={styles.accountActions}>
              <Button
                variant="glass"
                size="small"
                icon={<Camera size={14} />}
                onClick={openAvatarDialog}
              >
                更换头像
              </Button>
              <Button
                variant="glass"
                size="small"
                icon={<KeyRound size={14} />}
                onClick={openPasswordDialog}
              >
                修改密码
              </Button>
              <Button
                variant="glass"
                size="small"
                destructive
                icon={<LogOut size={14} />}
                onClick={handleSignOut}
              >
                退出登录
              </Button>
            </div>
          ) : (
            <Button variant="filled" onClick={() => setLoginModalOpen(true)}>
              立即登录
            </Button>
          )}
        </div>
      </Card>

      {auth.authenticated && <SocialBindingsCard />}

      <Card title="外观与桌面行为">
        <div className={styles.settingList}>
          <div className={styles.settingRow}>
            <div>
              <div className={styles.settingTitle}>狂热打卡符文火焰</div>
              <div className={styles.settingDesc}>
                工作室同时在岗达到 {feverThreshold} 人时显示火焰。关闭仅隐藏动画，不影响状态和积分加成。
              </div>
            </div>
            <Switch aria-label="狂热打卡符文火焰" checked={config.frenzyFlamesEnabled} onCheckedChange={(checked) => void updateConfig({ frenzyFlamesEnabled: checked })} />
          </div>
          <div className={styles.settingRow}>
            <div>
              <div className={styles.settingTitle}>界面主题</div>
              <div className={styles.settingDesc}>跟随系统或固定使用浅色 / 深色 Liquid Glass 界面</div>
            </div>
            <SegmentedControl
              value={config.theme}
              onValueChange={(v) => void updateConfig({ theme: v as ThemePreference })}
              items={[
                { value: 'system', label: '跟随系统' },
                { value: 'light', label: '浅色' },
                { value: 'dark', label: '深色' },
              ]}
            />
          </div>

          <div className={styles.settingRow}>
            <div>
              <div className={styles.settingTitle}>桌面打卡悬浮球</div>
              <div className={styles.settingDesc}>应用退至后台、最小化或隐藏至托盘时自动浮现，回到主窗自动收起</div>
            </div>
            <Switch
              checked={config.floatingBallEnabled}
              onCheckedChange={(checked) => void updateConfig({ floatingBallEnabled: checked })}
            />
          </div>

          <div className={styles.settingRow}>
            <div>
              <div className={styles.settingTitle}>关闭主窗口时最小化到托盘</div>
              <div className={styles.settingDesc}>保持打卡计时与通知常驻后台</div>
            </div>
            <Switch
              checked={config.closeToTray}
              onCheckedChange={(checked) => void updateConfig({ closeToTray: checked })}
            />
          </div>

          <div className={styles.settingRow}>
            <div>
              <div className={styles.settingTitle}>开机自动启动</div>
              <div className={styles.settingDesc}>仅打包安装后生效，便于日常考勤与全机 SSO 授权</div>
            </div>
            <Switch
              checked={config.autoLaunch}
              onCheckedChange={(checked) => void updateConfig({ autoLaunch: checked })}
            />
          </div>
        </div>
      </Card>

      {auth.authenticated && auth.isAdmin && <WifiFingerprintCard />}
      {auth.authenticated && auth.isStudioMember && auth.profile && hasStudioRole(
        auth.profile.organizationRoles, endpoints.ssoOrganizationId, ['captain', 'lec-captain'],
      ) && <DutyScheduleCard key={auth.profile.subject} />}

      <Card title="本地存储与版本">
        <div className={styles.footerRow}>
          <div className={styles.footerLeft}>
            <Tag tone="neutral">当前版本 v{updateInfo?.currentVersion ?? '0.1.0'}</Tag>
            {updateInfo?.checked && (
              <Tag tone={updateInfo.available ? 'info' : 'success'}>
                {updateInfo.available ? `发现新版本 v${updateInfo.latestVersion}` : '已是最新版本'}
              </Tag>
            )}
          </div>
          <div className={styles.footerRight}>
            <Button
              variant="glass"
              size="small"
              icon={<Sparkles size={14} />}
              onClick={() => setChangelogDialogOpen(true)}
            >
              {updateInfo?.available ? `v${updateInfo.latestVersion} 改了啥` : '本版更新日志'}
            </Button>
            <Button
              variant="glass"
              size="small"
              icon={<Trash2 size={14} />}
              onClick={() => void handleClearCache()}
            >
              清理本地缓存
            </Button>
            {updateInfo?.stage === 'downloaded' ? (
              <Button
                variant="filled"
                size="small"
                onClick={() => void getOrbitClient().system.installUpdate()}
              >
                {updateInfo.canAutoInstall ? '重启以更新' : '打开安装包更新'}
              </Button>
            ) : updateInfo?.available ? (
              <Button
                variant="filled"
                size="small"
                icon={<Download size={14} />}
                loading={updateInfo.stage === 'downloading'}
                onClick={() => void getOrbitClient().system.downloadUpdate()}
              >
                {updateInfo.stage === 'downloading'
                  ? (updateInfo.progressPercent ?? 0) >= 95 && updateInfo.canAutoInstall
                    ? '准备更新包…'
                    : `下载中 ${updateInfo.progressPercent ?? 0}%`
                  : `下载 v${updateInfo.latestVersion}`}
              </Button>
            ) : (
              <Button
                variant="glass"
                size="small"
                icon={<RefreshCw size={14} />}
                loading={checkingUpdate}
                onClick={() => void handleCheckUpdate()}
              >
                检查更新
              </Button>
            )}
          </div>
        </div>
      </Card>

      <UpdateChangelogDialog
        open={changelogDialogOpen}
        onOpenChange={setChangelogDialogOpen}
        mode={updateInfo?.available ? 'update' : 'history'}
        version={
          updateInfo?.available && updateInfo.latestVersion
            ? updateInfo.latestVersion
            : (updateInfo?.currentVersion ?? '0.2.0')
        }
        previousVersion={updateInfo?.available ? updateInfo.currentVersion : undefined}
        publishedAt={updateInfo?.publishedAt}
        releaseUrl={updateInfo?.releaseUrl}
        rawNotes={updateInfo?.releaseNotes}
        changelog={updateInfo?.available ? updateInfo.changelog : undefined}
        updateInfo={updateInfo?.available ? updateInfo : undefined}
      />

      <Dialog
        open={avatarDialogOpen}
        onOpenChange={setAvatarDialogOpen}
        size="small"
        title="更换 LecSSO 头像"
        description="上传后的头像会通过 LecSSO Account API 同步至 Orbit、LecPunch 与工作室其他应用。"
      >
        <div className={styles.dialogBody}>
          <div className={styles.avatarPreviewRow}>
            <Avatar
              src={avatarUrlInput.trim() || auth.profile?.avatar}
              name={displayName}
              size="large"
            />
            <div className={styles.avatarPreviewMeta}>
              <Button
                variant="filled"
                icon={<Upload size={15} />}
                loading={avatarBusy}
                onClick={() => void handleUploadLocalAvatar()}
              >
                选择本地图片上传
              </Button>
              <span className={styles.dialogHint}>支持 PNG / JPG / WEBP / GIF，最大 10MB</span>
            </div>
          </div>

          <form className={styles.dialogForm} onSubmit={handleSaveAvatarUrl}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>或填写头像图片链接（HTTPS）</span>
              <Input
                variant="fill"
                placeholder="https://..."
                value={avatarUrlInput}
                onValueChange={setAvatarUrlInput}
                disabled={avatarBusy}
              />
            </label>
            {avatarError && <Message tone="error">{avatarError}</Message>}
            <div className={styles.dialogFooter}>
              {auth.profile?.avatar ? (
                <Button
                  variant="glass"
                  size="small"
                  type="button"
                  destructive
                  disabled={avatarBusy}
                  onClick={() => void handleClearAvatar()}
                >
                  恢复默认
                </Button>
              ) : (
                <span />
              )}
              <div className={styles.dialogFooterRight}>
                <Button
                  variant="glass"
                  size="small"
                  type="button"
                  disabled={avatarBusy}
                  onClick={() => setAvatarDialogOpen(false)}
                >
                  取消
                </Button>
                <Button variant="filled" size="small" type="submit" loading={avatarBusy}>
                  保存链接
                </Button>
              </div>
            </div>
          </form>
        </div>
      </Dialog>

      <Dialog
        open={passwordDialogOpen}
        onOpenChange={setPasswordDialogOpen}
        size="small"
        title="修改 LecSSO 登录密码"
        description="将先校验当前密码，再按 LecSSO 安全策略更新你的统一身份密码。"
      >
        <form className={styles.dialogForm} onSubmit={handleChangePassword}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>当前密码</span>
            <Input
              variant="fill"
              type="password"
              placeholder="输入当前登录密码"
              value={currentPassword}
              onValueChange={setCurrentPassword}
              autoComplete="current-password"
              disabled={passwordBusy}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>新密码</span>
            <Input
              variant="fill"
              type="password"
              placeholder="至少 8 位，建议包含字母与数字"
              value={newPassword}
              onValueChange={setNewPassword}
              autoComplete="new-password"
              disabled={passwordBusy}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>确认新密码</span>
            <Input
              variant="fill"
              type="password"
              placeholder="再次输入新密码"
              value={confirmPassword}
              onValueChange={setConfirmPassword}
              autoComplete="new-password"
              disabled={passwordBusy}
            />
          </label>
          {passwordError && <Message tone="error">{passwordError}</Message>}
          <div className={styles.dialogFooter}>
            <span />
            <div className={styles.dialogFooterRight}>
              <Button
                variant="glass"
                size="small"
                type="button"
                disabled={passwordBusy}
                onClick={() => setPasswordDialogOpen(false)}
              >
                取消
              </Button>
              <Button variant="filled" size="small" type="submit" loading={passwordBusy}>
                确认修改
              </Button>
            </div>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
