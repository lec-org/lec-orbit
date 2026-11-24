import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import {
  Avatar,
  Button,
  Dialog,
  Drawer,
  Empty,
  Glass,
  Message,
  Popover,
  SearchField,
  SegmentedControl,
  Skeleton,
  Toolbar,
  ToolbarGroup,
  Tooltip,
} from '@lec-space/liquidglass';
import { ArrowLeft, ArrowRight, BookOpen, Copy, ExternalLink, House, Pencil, Plus, RefreshCw, RotateCcw, Trash2, Users } from '@lec-space/icons';
import { parseBlogUrl } from '@shared/blogUrl';
import { blogApi, hasBlogDevCaptain, hasBlogDevIdentity, type MemberBlogItem } from '@/services/blogApi';
import { getOrbitClient, isDesktopRuntime } from '@/services/orbitClient';
import { notifyToast } from '@/services/orbitToast';
import { useOrbitStore } from '@/stores/useOrbitStore';
import { BlogPostList } from './BlogPostList';
import { HiddenBlogsDialog } from './HiddenBlogsDialog';
import { MyBlogDialog } from './MyBlogDialog';
import { useBlogOverlay } from './useBlogOverlay';
import styles from './BlogHub.module.css';

const VIEW_OPTIONS = [{ value: 'browse', label: '浏览博客' }, { value: 'recent', label: '最新动态' }];

function memberName(member: MemberBlogItem): string {
  return member.displayName || member.username || member.blogTitle || member.userId;
}

function viewError(error: unknown): void {
  notifyToast({ tone: 'error', title: '无法操作博客视图', description: error instanceof Error ? error.message : undefined });
}

export function BlogHubPage(): JSX.Element {
  const auth = useOrbitStore((state) => state.auth);
  const memberBlogs = useOrbitStore((state) => state.memberBlogs);
  const myBlog = useOrbitStore((state) => state.myBlog);
  const blogState = useOrbitStore((state) => state.blogState);
  const blogsLoading = useOrbitStore((state) => state.blogsLoading);
  const blogsError = useOrbitStore((state) => state.blogsError);
  const selectedBlogUserId = useOrbitStore((state) => state.selectedBlogUserId);
  const pendingBlogUrl = useOrbitStore((state) => state.pendingBlogUrl);
  const refreshMemberBlogs = useOrbitStore((state) => state.refreshMemberBlogs);
  const setBlogState = useOrbitStore((state) => state.setBlogState);
  const setMyBlog = useOrbitStore((state) => state.setMyBlog);
  const openBlogTarget = useOrbitStore((state) => state.openBlogTarget);
  const consumeBlogUrl = useOrbitStore((state) => state.consumeBlogUrl);
  const clearBlogTarget = useOrbitStore((state) => state.clearBlogTarget);
  const setLoginModalOpen = useOrbitStore((state) => state.setLoginModalOpen);

  const [mode, setMode] = useState<'browse' | 'recent'>('browse');
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [tagFilterOpen, setTagFilterOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [hiddenManageOpen, setHiddenManageOpen] = useState(false);
  const [postsAuthor, setPostsAuthor] = useState<MemberBlogItem | null>(null);
  const [hideTarget, setHideTarget] = useState<MemberBlogItem | null>(null);
  const [hiding, setHiding] = useState(false);
  const [hideError, setHideError] = useState<string | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const desktop = isDesktopRuntime();
  const canAccess = auth.authenticated || hasBlogDevIdentity();
  const canHide = auth.isAdmin || (!auth.authenticated && hasBlogDevCaptain());
  const canEmbed = desktop && canAccess && mode === 'browse' && selectedBlogUserId !== null;
  const orbit = getOrbitClient();

  useBlogOverlay(tagFilterOpen);
  useBlogOverlay(postsAuthor !== null);
  useBlogOverlay(hideTarget !== null);

  useEffect(() => {
    if (canAccess) void refreshMemberBlogs();
  }, [canAccess, auth.profile?.subject, refreshMemberBlogs]);

  useEffect(() => {
    if (pendingBlogUrl) setMode('browse');
  }, [pendingBlogUrl]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!canEmbed || !host) return;

    const measure = () => {
      const rect = host.getBoundingClientRect();
      return {
        x: Math.max(0, Math.round(rect.left)),
        y: Math.max(0, Math.round(rect.top)),
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      };
    };
    const savedTarget = consumeBlogUrl();
    void orbit.blog.activate(measure(), savedTarget ?? undefined).catch(viewError);
    const syncBounds = () => { void orbit.blog.setBounds(measure()).catch(viewError); };
    const observer = new ResizeObserver(syncBounds);
    observer.observe(host);
    window.addEventListener('resize', syncBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncBounds);
      void orbit.blog.deactivate().catch(viewError);
    };
  }, [canEmbed, consumeBlogUrl, orbit]);

  useLayoutEffect(() => {
    if (!canAccess || mode !== 'browse' || !pendingBlogUrl) return;
    const target = consumeBlogUrl();
    if (!target) return;
    if (canEmbed) {
      void orbit.blog.navigate(target).catch(viewError);
    } else if (!desktop) {
      setBlogState({ ...useOrbitStore.getState().blogState, url: target });
    }
  }, [canAccess, canEmbed, consumeBlogUrl, desktop, mode, orbit, pendingBlogUrl, setBlogState]);

  const selected = memberBlogs.find((member) => member.userId === selectedBlogUserId);
  const current = parseBlogUrl(pendingBlogUrl || blogState.url || selected?.blogUrl);
  const tags = Array.from(new Set(memberBlogs.flatMap((member) => member.tags))).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const term = query.trim().toLocaleLowerCase();
  const visibleMembers = memberBlogs.filter((member) =>
    (!tag || member.tags.includes(tag)) &&
    (!term || [member.displayName, member.username, member.blogTitle, member.bio].some((value) => value.toLocaleLowerCase().includes(term))),
  );
  const ownBlogPresent = Boolean(myBlog || memberBlogs.some((member) => member.userId === auth.profile?.subject));

  function readPost(userId: string, url: string): void {
    setPostsAuthor(null);
    setMode('browse');
    openBlogTarget(userId, url);
  }

  async function copyUrl(): Promise<void> {
    if (!current) return;
    try {
      await orbit.system.copyText(current.href);
      notifyToast({ tone: 'success', title: '已复制博客链接' });
    } catch (error) {
      viewError(error);
    }
  }

  function openExternal(): void {
    if (!current) return;
    const action = desktop ? orbit.blog.openExternal() : orbit.system.openExternal(current.href);
    void action.catch(viewError);
  }

  async function hideBlog(): Promise<void> {
    if (!hideTarget) return;
    setHiding(true);
    setHideError(null);
    try {
      await blogApi.adminHideBlog(hideTarget.userId);
      clearBlogTarget(hideTarget.userId);
      if (myBlog?.userId === hideTarget.userId) setMyBlog({ ...myBlog, status: 'HIDDEN' });
      notifyToast({ tone: 'success', title: '博客已下架' });
      setHideTarget(null);
      void refreshMemberBlogs();
    } catch (error) {
      setHideError(error instanceof Error ? error.message : '下架博客失败');
    } finally {
      setHiding(false);
    }
  }

  return (
    <section className={styles.page} aria-labelledby="blog-hub-title">
      {orbit.platform === 'darwin' && <div className={`${styles.dragStrip} orbit-drag`} aria-hidden="true" />}
      <header className={`${styles.header} orbit-no-drag`}>
        <h1 id="blog-hub-title">成员博客</h1>
        {canAccess && (
          <div className={styles.headerControls}>
            <SearchField aria-label="搜索成员或博客" value={query} onValueChange={setQuery}
              placeholder="搜索成员或博客" variant="glass" className={styles.search} />
            <SegmentedControl aria-label="博客视图" items={VIEW_OPTIONS} value={mode}
              onValueChange={(value) => setMode(value === 'recent' ? 'recent' : 'browse')} />
            {canHide && (
              <Button variant="glass" size="small" icon={<RotateCcw size={14} />}
                onClick={() => setHiddenManageOpen(true)}>
                下架管理
              </Button>
            )}
            <Button variant="filled" size="small" icon={ownBlogPresent ? <Pencil size={15} /> : <Plus size={15} />}
              onClick={() => setConfigOpen(true)}>
              {ownBlogPresent ? '编辑我的博客' : '绑定我的博客'}
            </Button>
          </div>
        )}
      </header>

      {!canAccess ? (
        <Glass className={styles.centered}>
          <Empty icon={<Users size={30} />} title="登录后查看成员博客">
            <Button variant="filled" size="small" onClick={() => setLoginModalOpen(true)}>使用 LecSSO 登录</Button>
          </Empty>
        </Glass>
      ) : (
        <>
          {(memberBlogs.length > 0 || blogsLoading) && (
            <Glass className={`${styles.memberBar} orbit-no-drag`} aria-label="已绑定博客的成员">
              <div className={styles.memberScroll} aria-busy={blogsLoading}>
                {blogsLoading && memberBlogs.length === 0 ? (
                  [0, 1, 2, 3, 4].map((item) => (
                    <div key={item} className={styles.memberSkeleton} aria-hidden="true">
                      <Skeleton shape="circle" width={43} height={43} />
                      <Skeleton width={48} />
                    </div>
                  ))
                ) : visibleMembers.length > 0 ? (
                  visibleMembers.map((member) => (
                    <Tooltip key={member.userId} side="right" content={
                      <span className={styles.memberTooltip}>
                        <strong>{member.blogTitle || memberName(member)}</strong>
                        {member.bio && <span>{member.bio}</span>}
                        {member.latestPostTitle && <span>{member.latestPostTitle}</span>}
                        {member.latestPostAt && <time dateTime={member.latestPostAt}>{new Date(member.latestPostAt).toLocaleString('zh-CN')}</time>}
                      </span>
                    }>
                      <Button variant="glass" size="large" className={styles.memberButton}
                        aria-label={`浏览 ${memberName(member)} 的博客${member.hasRecentPost ? '，近 7 天有上新' : ''}`}
                        aria-pressed={member.userId === selectedBlogUserId}
                        onClick={() => readPost(member.userId, member.blogUrl)}>
                        <span className={styles.avatarFrame} data-recent={member.hasRecentPost || undefined}>
                          <Avatar src={member.avatarUrl || undefined} name={memberName(member)} size={43} shape="circle" />
                        </span>
                        <span className={styles.memberLabel}>{memberName(member)}</span>
                      </Button>
                    </Tooltip>
                  ))
                ) : (
                  <p className={styles.noMatches}>没有符合条件的成员</p>
                )}
              </div>
              {tags.length > 0 && (
                <Popover label={tag ?? '全部标签'} aria-label="按技术标签筛选"
                  open={tagFilterOpen} onOpenChange={setTagFilterOpen} align="end" width={240}
                  trigger={{ size: 'small', className: styles.filterButton,
                    'aria-label': tag ? `按技术标签筛选，当前标签 ${tag}` : '按技术标签筛选' }}>
                  {({ close }) => (
                    <div className={styles.filterOptions}>
                      <Button variant={tag === null ? 'filled' : 'glass'} size="small"
                        onClick={() => { setTag(null); close(); }}>全部标签</Button>
                      {tags.map((value) => (
                        <Button key={value} variant={tag === value ? 'filled' : 'glass'} size="small"
                          onClick={() => { setTag(value); close(); }}>{value}</Button>
                      ))}
                    </div>
                  )}
                </Popover>
              )}
            </Glass>
          )}

          {blogsError && (
            <div className={styles.inlineStatus}>
              <Message className={styles.warning}>{blogsError}</Message>
              <Button variant="glass" size="small" onClick={() => void refreshMemberBlogs()}>重试</Button>
            </div>
          )}

          {mode === 'recent' ? (
            <div className={styles.recentScroll}>
              <BlogPostList onRead={readPost} />
            </div>
          ) : (
            <Glass className={styles.browserPane}>
              {selectedBlogUserId && (
                <Toolbar className={`${styles.toolbar} orbit-no-drag`} edge="none" aria-label="博客浏览工具栏">
                  <ToolbarGroup className={styles.browserControls}>
                    <Button size="small" aria-label="后退" title="后退" disabled={!desktop || !blogState.canGoBack}
                      icon={<ArrowLeft size={16} />} onClick={() => void orbit.blog.goBack().catch(viewError)} />
                    <Button size="small" aria-label="前进" title="前进" disabled={!desktop || !blogState.canGoForward}
                      icon={<ArrowRight size={16} />} onClick={() => void orbit.blog.goForward().catch(viewError)} />
                    <Button size="small" aria-label="刷新博客" title="刷新博客" disabled={!desktop || !current}
                      loading={desktop && blogState.loading} icon={<RefreshCw size={15} />}
                      onClick={() => void orbit.blog.reload().catch(viewError)} />
                    <Button size="small" aria-label="回到博客首页" title="回到博客首页" disabled={!selected}
                      icon={<House size={16} />} onClick={() => selected && readPost(selected.userId, selected.blogUrl)} />
                  </ToolbarGroup>

                  <div className={styles.siteMeta}>
                    {selected && <Avatar src={selected.avatarUrl || undefined} name={memberName(selected)} size="small" />}
                    <div className={styles.siteLabels}>
                      <strong title={selected?.blogTitle || blogState.title}>
                        {selected?.blogTitle || (selected ? memberName(selected) : blogState.title || current?.hostname)}
                      </strong>
                      <span title={current?.href}>
                        {selected && selected.blogTitle ? `${memberName(selected)} · ` : ''}{current?.host}
                      </span>
                    </div>
                  </div>

                  <ToolbarGroup className={styles.browserActions}>
                    {selected && (selected.rssUrl || selected.latestPostAt) && (
                      <Button size="small" icon={<BookOpen size={15} />} onClick={() => setPostsAuthor(selected)}>Ta 的文章</Button>
                    )}
                    <Button size="small" aria-label="复制当前链接" title="复制当前链接" disabled={!current}
                      icon={<Copy size={15} />} onClick={() => void copyUrl()} />
                    <Button size="small" aria-label="在系统浏览器打开" title="在系统浏览器打开" disabled={!current}
                      icon={<ExternalLink size={15} />} onClick={openExternal} />
                    {canHide && selected && (
                      <Button size="small" aria-label="下架该博客" title="下架该博客" destructive icon={<Trash2 size={15} />}
                        onClick={() => { setHideError(null); setHideTarget(selected); }} />
                    )}
                  </ToolbarGroup>
                </Toolbar>
              )}
              <div ref={hostRef} className={styles.viewport} aria-label="博客阅读视口">
                {!selectedBlogUserId ? (
                  <Empty icon={<BookOpen size={30} />}
                    title={memberBlogs.length ? '选择一位成员开始浏览' : blogsLoading ? '正在读取成员博客' : '还没有成员绑定博客'}
                    description={memberBlogs.length ? '点击上方头像打开博客主页。' : undefined} />
                ) : blogState.overlayHidden && desktop ? (
                  <Empty title="浏览已暂停" description="关闭弹层即可回到原来的页面。" />
                ) : !desktop ? (
                  <Empty icon={<ExternalLink size={25} />} title="在浏览器中阅读博客">
                    <Button size="small" variant="glass" icon={<ExternalLink size={15} />} disabled={!current}
                      onClick={openExternal}>打开博客</Button>
                  </Empty>
                ) : blogState.loadError ? (
                  <Empty icon={<BookOpen size={26} />} title={blogState.loadError}>
                    <div className={styles.emptyActions}>
                      <Button size="small" variant="glass" icon={<RefreshCw size={15} />}
                        onClick={() => void orbit.blog.reload().catch(viewError)}>重试</Button>
                      <Button size="small" variant="glass" icon={<ExternalLink size={15} />}
                        disabled={!current} onClick={openExternal}>在浏览器打开</Button>
                    </div>
                  </Empty>
                ) : !blogState.mounted && (
                  <Empty title="正在打开博客" />
                )}
              </div>
            </Glass>
          )}
        </>
      )}

      <MyBlogDialog open={configOpen && canAccess} onOpenChange={setConfigOpen} />
      <HiddenBlogsDialog open={hiddenManageOpen && canHide} onOpenChange={setHiddenManageOpen} />
      <Drawer open={postsAuthor !== null} onOpenChange={(open) => { if (!open) setPostsAuthor(null); }}
        side="end" size="regular" title={postsAuthor ? `${memberName(postsAuthor)}的文章` : '成员文章'}>
        {postsAuthor && <BlogPostList key={postsAuthor.userId} authorId={postsAuthor.userId} onRead={readPost} />}
      </Drawer>
      <Dialog
        open={hideTarget !== null}
        onOpenChange={(open) => { if (!open) setHideTarget(null); }}
        title="下架成员博客"
        description={hideTarget ? `下架后，${hideTarget.blogTitle || memberName(hideTarget)}的博客和文章将从成员列表及最新动态中隐藏。` : undefined}
        size="small"
        dismissible={!hiding}
        footer={
          <div className={styles.dialogActions}>
            <Button size="small" variant="glass" disabled={hiding} onClick={() => setHideTarget(null)}>取消</Button>
            <Button size="small" variant="filled" destructive loading={hiding} onClick={() => void hideBlog()}>确认下架</Button>
          </div>
        }
      >
        {hideError && <Message tone="error">{hideError}</Message>}
      </Dialog>
    </section>
  );
}
