/** Stage 2 独立全机 LecSSO 授权确认浮窗：核对目标应用名、来源 IP、2 位确认码并在高敏应用叠加生物识别。 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { Avatar, Button, Card, Message, Spinner, Tag } from '@lec-space/liquidglass';
import { Check, ShieldCheck, X } from '@lec-space/icons';
import type { AuthState, OrbitChallengeDetail } from '@shared/ipc';
import { getOrbitClient } from '@/services/orbitClient';
import styles from './ApprovePage.module.css';

export interface ApprovePageProps {
  initialChallengeId: string;
}

export function ApprovePage({ initialChallengeId }: ApprovePageProps): JSX.Element {
  const [challengeId, setChallengeId] = useState(initialChallengeId);
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [detail, setDetail] = useState<OrbitChallengeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneText, setDoneText] = useState<string | null>(null);

  const loadChallenge = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    setDoneText(null);
    const orbit = getOrbitClient();
    try {
      const [authState, challengeDetail] = await Promise.all([
        orbit.auth.getState(),
        orbit.approve.getChallenge(id),
      ]);
      setAuth(authState);
      setDetail(challengeDetail);
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法加载授权请求详情。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadChallenge(challengeId);
  }, [challengeId, loadChallenge]);

  useEffect(() => {
    return getOrbitClient().approve.onChallengeReceived((event) => {
      setChallengeId(event.challengeId);
    });
  }, []);

  const handleDecision = async (action: 'approve' | 'deny') => {
    if (!detail) return;
    setSubmitting(true);
    setError(null);
    const orbit = getOrbitClient();
    try {
      if (action === 'approve' && detail.riskLevel === 'high') {
        const verified = await orbit.approve.promptBiometric(
          `批准高敏应用「${detail.appName}」的 LecSSO 登录请求`,
        );
        if (!verified) {
          setError('未通过系统生物识别验证，已取消本次批准。');
          setSubmitting(false);
          return;
        }
      }
      await orbit.approve.decide(detail.challengeId, action);
      setDoneText(action === 'approve' ? '已批准登录，浏览器即将自动进入…' : '已拒绝本次登录请求。');
      window.setTimeout(() => {
        void orbit.approve.closeWindow();
      }, 1100);
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交授权决定失败。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.root}>
      <div className={`${styles.dragBar} orbit-drag`}>
        <span className={styles.title}>
          <ShieldCheck size={16} /> Orbit · 全机 LecSSO 授权确认
        </span>
        <button
          type="button"
          className={`${styles.closeBtn} orbit-no-drag`}
          aria-label="关闭窗口"
          onClick={() => void getOrbitClient().approve.closeWindow()}
        >
          <X size={15} />
        </button>
      </div>

      <div className={styles.body}>
        {loading ? (
          <div className={styles.center}>
            <Spinner />
            <span>正在向 LecSSO 核验授权请求…</span>
          </div>
        ) : error ? (
          <Card title="无法处理此登录请求">
            <Message tone="error">{error}</Message>
            <Button
              variant="glass"
              onClick={() => void getOrbitClient().approve.closeWindow()}
              className={styles.fullBtn}
            >
              关闭窗口
            </Button>
          </Card>
        ) : doneText ? (
          <Card title="操作已完成">
            <p className={styles.doneText}>{doneText}</p>
          </Card>
        ) : detail ? (
          <Card
            title={detail.appName}
            description={detail.clientHost ? `来源站点：${detail.clientHost}` : '正在请求使用你的 LecSSO 身份登录'}
            extra={
              <Tag tone={detail.riskLevel === 'high' ? 'warning' : 'info'}>
                {detail.riskLevel === 'high' ? '高敏管理入口' : '常规应用'}
              </Tag>
            }
          >
            <div className={styles.confirmBox}>
              <span className={styles.confirmLabel}>请核对浏览器页面显示的确认码</span>
              <strong className={styles.confirmCode}>{detail.confirmCode}</strong>
            </div>

            <div className={styles.metaList}>
              <div className={styles.metaRow}>
                <span>请求 IP</span>
                <strong>{detail.requesterIp}</strong>
              </div>
              <div className={styles.metaRow}>
                <span>授权账号</span>
                <span className={styles.accountPill}>
                  <Avatar
                    src={auth?.profile?.avatar}
                    name={auth?.profile?.name || auth?.profile?.username || '成员'}
                    size="small"
                  />
                  {auth?.profile?.name || auth?.profile?.username || '当前 Orbit 账号'}
                </span>
              </div>
            </div>

            {detail.riskLevel === 'high' && (
              <p className={styles.highRiskNote}>
                此入口涉及发布或身份管理，点击「确认登录」后将调用系统 Touch ID / 生物识别二次核验。
              </p>
            )}

            <div className={styles.actions}>
              <Button
                variant="glass"
                destructive
                disabled={submitting}
                onClick={() => void handleDecision('deny')}
              >
                拒绝
              </Button>
              <Button
                variant="filled"
                icon={<Check size={15} />}
                loading={submitting}
                disabled={detail.status !== 'pending'}
                onClick={() => void handleDecision('approve')}
              >
                确认登录
              </Button>
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
