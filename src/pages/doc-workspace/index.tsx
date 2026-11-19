/** LecDoc 原生一体化工作区宿主：全屏无缝承载本地 LecDoc 前端包、WebContentsView 坐标同步、弹窗避让与编辑权申请弹窗。 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from 'react';
import { Button, Dialog, Input, Message } from '@lec-space/liquidglass';
import { getOrbitClient, isDesktopRuntime } from '@/services/orbitClient';
import { orbitServerApi } from '@/services/orbitServerApi';
import { notifyToast } from '@/services/orbitToast';
import { useOrbitStore } from '@/stores/useOrbitStore';
import styles from './DocWorkspace.module.css';

function extractDocPageKey(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    const match = u.pathname.match(/\/(?:p|wiki)\/([^/?#]+)/);
    if (!match?.[1]) return null;
    const segment = decodeURIComponent(match[1]);
    const hyphenIdx = segment.lastIndexOf('-');
    return hyphenIdx > 0 ? segment.slice(hyphenIdx + 1) : segment;
  } catch {
    return null;
  }
}

export function DocWorkspacePage(): JSX.Element {
  const docState = useOrbitStore((s) => s.docState);
  const setDocState = useOrbitStore((s) => s.setDocState);
  const pushOverlay = useOrbitStore((s) => s.pushOverlay);
  const popOverlay = useOrbitStore((s) => s.popOverlay);
  const hostRef = useRef<HTMLDivElement>(null);

  const [reqOpen, setReqOpen] = useState(false);
  const [reqReason, setReqReason] = useState('');
  const [reqOverridePageKey, setReqOverridePageKey] = useState<string | null>(null);
  const [reqOverrideTitle, setReqOverrideTitle] = useState<string | null>(null);
  const [reqSubmitting, setReqSubmitting] = useState(false);
  const [reqError, setReqError] = useState<string | null>(null);

  const currentPageKey = useMemo(
    () => docState.pageContext?.pageId || docState.pageContext?.pageSlug || extractDocPageKey(docState.url),
    [docState.pageContext?.pageId, docState.pageContext?.pageSlug, docState.url],
  );
  const activeRequestPageKey = reqOverridePageKey || currentPageKey;
  const activeRequestTitle = reqOverrideTitle || docState.pageContext?.pageTitle || docState.title || '当前文档';

  useEffect(() => {
    const off = getOrbitClient().doc.onEditRequestTriggered((payload) => {
      setReqOverridePageKey(payload.pageId || payload.pageSlug || null);
      setReqOverrideTitle(payload.pageTitle || null);
      if (payload.reason) setReqReason(payload.reason);
      setReqError(null);
      setReqOpen(true);
    });
    return () => off();
  }, []);

  useEffect(() => {
    if (!reqOpen) return;
    pushOverlay();
    return () => popOverlay();
  }, [reqOpen, pushOverlay, popOverlay]);

  useEffect(() => {
    const orbit = getOrbitClient();
    const measureAndSync = (activate: boolean) => {
      const el = hostRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const bounds = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      };
      if (activate) {
        void orbit.doc.activate(bounds).then(setDocState);
      } else {
        void orbit.doc.setBounds(bounds);
      }
    };

    measureAndSync(true);
    const observer = new ResizeObserver(() => measureAndSync(false));
    if (hostRef.current) observer.observe(hostRef.current);
    const onResize = () => measureAndSync(false);
    window.addEventListener('resize', onResize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      void orbit.doc.deactivate();
    };
  }, [setDocState]);

  const handleSubmitEditRequest = async (e: FormEvent) => {
    e.preventDefault();
    if (!activeRequestPageKey) {
      setReqError('请先打开具体文档页面再申请编辑权限。');
      return;
    }
    setReqSubmitting(true);
    setReqError(null);
    try {
      const res = await orbitServerApi.createDocEditRequest(
        activeRequestPageKey,
        reqReason.trim() || '申请协作编辑该文档',
      );
      setReqOpen(false);
      setReqReason('');
      setReqOverridePageKey(null);
      setReqOverrideTitle(null);
      notifyToast({
        tone: 'success',
        title: '编辑权限申请已发出',
        description: res.description,
      });
    } catch (err) {
      setReqError(err instanceof Error ? err.message : '提交编辑权限申请失败，请稍后重试。');
    } finally {
      setReqSubmitting(false);
    }
  };

  return (
    <div className={styles.wrapper}>
      <div ref={hostRef} className={styles.viewport}>
        {(!isDesktopRuntime() || docState.overlayHidden) && (
          <div className={styles.placeholder}>
            <p className={styles.placeholderTitle}>
              {docState.overlayHidden
                ? '文档视图已临时避让当前弹窗'
                : 'LecDoc 仅在 Electron 桌面运行时通过 WebContentsView 内嵌渲染'}
            </p>
            <p className={styles.placeholderSub}>
              {docState.overlayHidden
                ? '关闭弹窗后自动恢复原浏览位置'
                : `目标地址：${docState.url}`}
            </p>
          </div>
        )}
      </div>

      <Dialog
        open={reqOpen}
        onOpenChange={(open) => {
          setReqOpen(open);
          if (!open) {
            setReqOverridePageKey(null);
            setReqOverrideTitle(null);
          }
        }}
        size="small"
        title="申请云文档编辑权限"
        description={`将向《${activeRequestTitle}》作者的 Orbit 推送实时审批卡片，对方同意后立即生效。`}
      >
        <form onSubmit={handleSubmitEditRequest} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Input
            variant="fill"
            placeholder="简述申请编辑的理由（选填）"
            value={reqReason}
            onValueChange={setReqReason}
            disabled={reqSubmitting}
          />
          {reqError && <Message tone="error">{reqError}</Message>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="glass" size="small" type="button" onClick={() => setReqOpen(false)}>
              取消
            </Button>
            <Button variant="filled" size="small" type="submit" loading={reqSubmitting}>
              发送给作者审批
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
