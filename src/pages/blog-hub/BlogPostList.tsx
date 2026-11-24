import { useEffect, useState, type JSX } from 'react';
import { Avatar, Button, Card, Empty, Message, Pagination, Skeleton, Tag } from '@lec-space/liquidglass';
import { ArrowRight, BookOpen } from '@lec-space/icons';
import { parseBlogUrl } from '@shared/blogUrl';
import { blogApi, type BlogPageResult, type BlogPostItem } from '@/services/blogApi';
import styles from './BlogHub.module.css';

const PAGE_SIZE = 10;

interface BlogPostListProps {
  authorId?: string;
  onRead: (userId: string, url: string) => void;
}

export function BlogPostList({ authorId, onRead }: BlogPostListProps): JSX.Element {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<BlogPageResult<BlogPostItem> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const request = authorId
      ? blogApi.listAuthorPosts(authorId, page, PAGE_SIZE, controller.signal)
      : blogApi.listRecentPosts(page, PAGE_SIZE, controller.signal);

    void request
      .then((data) => {
        if (!controller.signal.aborted) setResult(data);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setError(error instanceof Error ? error.message : '无法读取博客文章');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [authorId, page, retry]);

  return (
    <div className={styles.postList} aria-busy={loading}>
      {loading ? (
        <Card className={styles.postSkeleton} aria-label="正在加载文章">
          <Skeleton width="45%" />
          <Skeleton width="70%" />
          <Skeleton width="55%" />
        </Card>
      ) : error ? (
        <div className={styles.inlineStatus}>
          <Message tone="error">{error}</Message>
          <Button variant="glass" size="small" onClick={() => setRetry((count) => count + 1)}>重试</Button>
        </div>
      ) : !result?.items.length ? (
        <Empty
          icon={<BookOpen size={26} />}
          title={authorId ? '这位成员还没有同步文章' : '暂无博客动态'}
          description={authorId ? '仍可打开博客主页查看原文。' : '成员的 RSS 或 Atom 文章同步后会显示在这里。'}
        />
      ) : (
        result.items.map((item) => {
          const author = item.displayName || item.username || item.blogTitle || item.userId;
          const url = parseBlogUrl(item.postUrl);
          return (
            <Card key={item.id} padding="small" className={styles.postCard}>
              <div className={styles.postMeta}>
                <Avatar src={item.avatarUrl || undefined} name={author} size="small" />
                <span title={item.blogTitle || author}>{author}{item.blogTitle && item.blogTitle !== author ? ` · ${item.blogTitle}` : ''}</span>
                <time dateTime={item.publishedAt}>{new Date(item.publishedAt).toLocaleDateString('zh-CN')}</time>
              </div>
              <h3>{item.title}</h3>
              {item.summary && <p className={styles.postSummary}>{item.summary}</p>}
              <div className={styles.postActions}>
                <Tag tone="neutral">{item.sourceType === 'NATIVE' ? '站内' : 'RSS / Atom'}</Tag>
                <Button
                  size="small"
                  variant="glass"
                  icon={<ArrowRight size={14} />}
                  aria-label={`阅读原文《${item.title}》`}
                  disabled={!url}
                  onClick={() => url && onRead(item.userId, url.href)}
                >
                  阅读原文
                </Button>
              </div>
            </Card>
          );
        })
      )}
      {result && result.total > PAGE_SIZE && (
        <div className={styles.pagination}>
          <Pagination
            aria-label="博客文章分页"
            total={result.total}
            page={page}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
            disabled={loading}
          />
        </div>
      )}
    </div>
  );
}
