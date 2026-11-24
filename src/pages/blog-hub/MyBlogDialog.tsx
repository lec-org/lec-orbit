import { useEffect, useId, useState, type FormEvent, type JSX } from 'react';
import { Button, Dialog, FormField, Input, Message, Skeleton, Switch, Tag, TextArea } from '@lec-space/liquidglass';
import { RefreshCw, Trash2 } from '@lec-space/icons';
import { parseBlogUrl } from '@shared/blogUrl';
import { blogApi, BlogApiError } from '@/services/blogApi';
import { notifyToast } from '@/services/orbitToast';
import { useOrbitStore } from '@/stores/useOrbitStore';
import { useBlogOverlay } from './useBlogOverlay';
import styles from './BlogHub.module.css';

interface MyBlogForm {
  blogUrl: string;
  blogTitle: string;
  bio: string;
  tags: string[];
  rssUrl: string;
  autoDiscoverRss: boolean;
}

const EMPTY_FORM: MyBlogForm = { blogUrl: '', blogTitle: '', bio: '', tags: [], rssUrl: '', autoDiscoverRss: true };

export function MyBlogDialog({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const myBlog = useOrbitStore((state) => state.myBlog);
  const setMyBlog = useOrbitStore((state) => state.setMyBlog);
  const refreshMemberBlogs = useOrbitStore((state) => state.refreshMemberBlogs);
  const clearBlogTarget = useOrbitStore((state) => state.clearBlogTarget);
  const formId = useId();
  const [form, setForm] = useState<MyBlogForm>(EMPTY_FORM);
  const [tag, setTag] = useState('');
  const [tagError, setTagError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'delete' | 'sync' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [retry, setRetry] = useState(0);

  useBlogOverlay(open);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setError(null);
    setWarning(null);
    setTag('');
    setTagError(null);
    setConfirmDelete(false);

    void blogApi.getMyBlog(controller.signal)
      .then((detail) => {
        if (controller.signal.aborted) return;
        setMyBlog(detail);
        setForm(detail ? {
          blogUrl: detail.blogUrl,
          blogTitle: detail.blogTitle,
          bio: detail.bio,
          tags: detail.tags,
          rssUrl: detail.rssUrl ?? '',
          autoDiscoverRss: !detail.rssUrl,
        } : EMPTY_FORM);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setLoadError(error instanceof Error ? error.message : '无法读取博客配置');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, retry, setMyBlog]);

  function addTag(): boolean {
    const value = tag.trim();
    if (!value) return true;
    if (form.tags.length === 8 || value.length > 24) {
      setTagError(form.tags.length === 8 ? '最多添加 8 个标签' : '每个标签最多 24 字');
      return false;
    }
    if (!form.tags.includes(value)) {
      setForm((current) => ({ ...current, tags: [...current.tags, value] }));
    }
    setTag('');
    setTagError(null);
    return true;
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const blogUrl = parseBlogUrl(form.blogUrl);
    const rssUrl = form.rssUrl.trim();
    if (!blogUrl || (rssUrl && !parseBlogUrl(rssUrl))) {
      setError('博客主页和订阅地址需要填写有效的 HTTP 或 HTTPS 地址。');
      return;
    }
    if (!addTag()) return;
    const tagToSave = tag.trim();
    const tags = tagToSave && !form.tags.includes(tagToSave) ? [...form.tags, tagToSave] : form.tags;
    setBusy('save');
    setError(null);
    setWarning(null);
    try {
      setMyBlog(await blogApi.upsertMyBlog({ ...form, blogUrl: blogUrl.href, rssUrl, tags }));
      notifyToast({ tone: 'success', title: '博客已保存' });
      onOpenChange(false);
      void refreshMemberBlogs();
    } catch (error) {
      setError(error instanceof Error ? error.message : '无法保存博客配置');
    } finally {
      setBusy(null);
    }
  }

  async function unbind(): Promise<void> {
    if (!myBlog) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy('delete');
    setError(null);
    setWarning(null);
    try {
      await blogApi.deleteMyBlog();
      setMyBlog(null);
      clearBlogTarget(myBlog.userId);
      notifyToast({ tone: 'success', title: '博客已解绑' });
      onOpenChange(false);
      void refreshMemberBlogs();
    } catch (error) {
      setError(error instanceof Error ? error.message : '无法解绑博客');
    } finally {
      setBusy(null);
    }
  }

  async function syncNow(): Promise<void> {
    setBusy('sync');
    setError(null);
    setWarning(null);
    try {
      await blogApi.syncMyBlog();
      notifyToast({ tone: 'info', title: '已提交文章同步请求' });
      void blogApi.getMyBlog().then(setMyBlog).catch(() => undefined);
    } catch (error) {
      if (error instanceof BlogApiError && error.status === 429) {
        setWarning(error.message);
      } else {
        setError(error instanceof Error ? error.message : '无法启动文章同步');
      }
    } finally {
      setBusy(null);
    }
  }

  const hidden = myBlog?.status === 'HIDDEN';
  const fieldsDisabled = Boolean(busy) || hidden;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={myBlog ? '编辑我的博客' : '绑定我的博客'}
      size="regular"
      dismissible={!busy}
      footer={
        <div className={styles.dialogFooter}>
          {myBlog && (
            <Button
              variant="glass"
              size="small"
              destructive
              icon={<Trash2 size={14} />}
              onClick={() => void unbind()}
              disabled={hidden || Boolean(busy) || loading || Boolean(loadError)}
              loading={busy === 'delete'}
            >
              {confirmDelete ? '确认解绑' : '解绑博客'}
            </Button>
          )}
          <div className={styles.dialogActions}>
            <Button variant="glass" size="small" disabled={Boolean(busy)} onClick={() => onOpenChange(false)}>取消</Button>
            <Button
              type="submit"
              form={formId}
              variant="filled"
              size="small"
              disabled={hidden || loading || Boolean(loadError) || Boolean(busy)}
              loading={busy === 'save'}
            >
              保存
            </Button>
          </div>
        </div>
      }
    >
      {loading ? (
        <div className={styles.postSkeleton} aria-label="正在读取博客配置" aria-busy="true">
          <Skeleton width="100%" height={40} shape="rounded" />
          <Skeleton width="100%" height={40} shape="rounded" />
        </div>
      ) : loadError ? (
        <div className={styles.inlineStatus}>
          <Message tone="error">{loadError}</Message>
          <Button variant="glass" size="small" onClick={() => setRetry((count) => count + 1)}>重试</Button>
        </div>
      ) : (
        <form id={formId} className={styles.form} onSubmit={(event) => void save(event)}>
          {hidden && <Message className={styles.warning}>博客已被队长下架，当前无法修改、同步或解绑，请联系队长恢复。</Message>}
          <FormField label="博客主页 URL" required disabled={fieldsDisabled}>
            {(props) => <Input {...props} type="url" maxLength={512} variant="fill" value={form.blogUrl}
              onValueChange={(blogUrl) => setForm({ ...form, blogUrl })} placeholder="https://example.com" />}
          </FormField>
          <FormField label="博客名称" disabled={fieldsDisabled}>
            {(props) => <Input {...props} maxLength={128} variant="fill" value={form.blogTitle}
              onValueChange={(blogTitle) => setForm({ ...form, blogTitle })} />}
          </FormField>
          <FormField label="一句话简介" disabled={fieldsDisabled}>
            {(props) => <TextArea {...props} rows={3} maxLength={300} showCount variant="fill" value={form.bio}
              onValueChange={(bio) => setForm({ ...form, bio })} />}
          </FormField>
          <FormField label="技术标签" description="按回车添加，最多 8 个" error={tagError} disabled={fieldsDisabled}>
            {(props) => (
              <div className={styles.tagField}>
                {form.tags.map((value) => (
                  <Tag key={value} tone="info" closeLabel={`移除 ${value}`}
                    onClose={fieldsDisabled ? undefined : () => setForm({ ...form, tags: form.tags.filter((item) => item !== value) })}>
                    {value}
                  </Tag>
                ))}
                <Input {...props} maxLength={24} variant="fill" value={tag}
                  disabled={fieldsDisabled || form.tags.length >= 8}
                  onValueChange={(value) => { setTag(value); setTagError(null); }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      addTag();
                    }
                  }}
                />
              </div>
            )}
          </FormField>
          <FormField label="RSS / Atom 地址" disabled={fieldsDisabled}>
            {(props) => <Input {...props} type="url" maxLength={512} variant="fill" value={form.rssUrl}
              onValueChange={(rssUrl) => setForm({ ...form, rssUrl })} />}
          </FormField>
          <FormField label="未填订阅地址时自动探测首页" disabled={fieldsDisabled || Boolean(form.rssUrl.trim())}>
            {(props) => <Switch {...props} checked={form.autoDiscoverRss}
              onCheckedChange={(autoDiscoverRss) => setForm({ ...form, autoDiscoverRss })} />}
          </FormField>
          {myBlog?.rssUrl && (
            <div className={styles.syncBox}>
              <span>上次同步 {myBlog.lastSyncedAt ? new Date(myBlog.lastSyncedAt).toLocaleString('zh-CN') : '尚未同步'}</span>
              <Button variant="glass" size="small" icon={<RefreshCw size={14} />} disabled={hidden || Boolean(busy)}
                loading={busy === 'sync'} onClick={() => void syncNow()}>
                立即同步文章
              </Button>
              {myBlog.syncError && <Message className={styles.warning}>{myBlog.syncError}</Message>}
            </div>
          )}
          {confirmDelete && <Message className={styles.warning}>解绑会清理已同步的文章。再次点击「确认解绑」继续。</Message>}
          {warning && <Message className={styles.warning}>{warning}</Message>}
          {error && <Message tone="error">{error}</Message>}
        </form>
      )}
    </Dialog>
  );
}
