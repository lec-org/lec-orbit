import { useEffect, useState, type JSX } from 'react';
import { Avatar, Button, Dialog, Empty, Message, Skeleton } from '@lec-space/liquidglass';
import { BookOpen, RotateCcw } from '@lec-space/icons';
import { blogApi, type MemberBlogItem } from '@/services/blogApi';
import { notifyToast } from '@/services/orbitToast';
import { useOrbitStore } from '@/stores/useOrbitStore';
import { useBlogOverlay } from './useBlogOverlay';
import styles from './BlogHub.module.css';

function memberName(member: MemberBlogItem): string {
  return member.displayName || member.username || member.blogTitle || member.userId;
}

export function HiddenBlogsDialog({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const myBlog = useOrbitStore((state) => state.myBlog);
  const setMyBlog = useOrbitStore((state) => state.setMyBlog);
  const refreshMemberBlogs = useOrbitStore((state) => state.refreshMemberBlogs);

  const [items, setItems] = useState<MemberBlogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useBlogOverlay(open);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void blogApi.listHiddenBlogs(controller.signal)
      .then((list) => {
        if (!controller.signal.aborted) setItems(list);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : '无法读取已下架博客列表');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, retry]);

  async function restore(member: MemberBlogItem): Promise<void> {
    setRestoringId(member.userId);
    setError(null);
    try {
      await blogApi.adminRestoreBlog(member.userId);
      setItems((prev) => prev.filter((item) => item.userId !== member.userId));
      if (myBlog?.userId === member.userId) setMyBlog({ ...myBlog, status: 'ACTIVE' });
      notifyToast({ tone: 'success', title: `已恢复 ${memberName(member)} 的博客` });
      void refreshMemberBlogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : '恢复博客失败');
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="已下架博客管理"
      description="恢复后，对应成员的博客名片与文章将重新展示在成员列表及最新动态中。"
      size="regular"
      dismissible={!restoringId}
      footer={
        <div className={styles.dialogActions}>
          <Button variant="glass" size="small" disabled={Boolean(restoringId)} onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </div>
      }
    >
      {loading ? (
        <div className={styles.postSkeleton} aria-label="正在加载已下架博客" aria-busy="true">
          <Skeleton width="100%" height={48} shape="rounded" />
          <Skeleton width="100%" height={48} shape="rounded" />
        </div>
      ) : (
        <div className={styles.hiddenList}>
          {error && (
            <div className={styles.inlineStatus}>
              <Message tone="error">{error}</Message>
              <Button variant="glass" size="small" onClick={() => setRetry((n) => n + 1)}>重试</Button>
            </div>
          )}
          {!error && items.length === 0 ? (
            <Empty icon={<BookOpen size={24} />} title="当前没有已下架的博客" />
          ) : (
            items.map((item) => (
              <div key={item.userId} className={styles.hiddenRow}>
                <Avatar src={item.avatarUrl || undefined} name={memberName(item)} size="small" />
                <div className={styles.hiddenInfo}>
                  <strong>{item.blogTitle || memberName(item)}</strong>
                  <span title={item.blogUrl}>{memberName(item)} · {item.blogUrl}</span>
                </div>
                <Button
                  variant="filled"
                  size="small"
                  icon={<RotateCcw size={13} />}
                  loading={restoringId === item.userId}
                  disabled={Boolean(restoringId)}
                  onClick={() => void restore(item)}
                >
                  恢复上架
                </Button>
              </div>
            ))
          )}
        </div>
      )}
    </Dialog>
  );
}
