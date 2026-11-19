/** 统一通知与公告中心：左侧「应用图标 + 名称」竖向频道列表，右侧实时消息流 / 审批卡片 / 队长富文本公告与 IM 全员已读回执。 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type JSX, type ReactNode } from 'react';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Dialog,
  Empty,
  Input,
  Message,
  SegmentedControl,
  Switch,
  Tag,
} from '@lec-space/liquidglass';
import { BookOpen, Check, Clock3, Trash2 } from '@lec-space/icons';
import {
  BellRing,
  Bold,
  CheckCheck,
  Code,
  Code2,
  Eye,
  HardDrive,
  Heading2,
  ImagePlus,
  Inbox,
  Italic,
  Link2,
  List,
  ListOrdered,
  Megaphone,
  Pencil,
  Pin,
  Plus,
  Quote,
  ShieldCheck,
  Underline,
  X,
} from 'lucide-react';
import {
  orbitServerApi,
  type OrbitAnnouncement,
  type OrbitAnnouncementReceipts,
  type OrbitNotificationItem,
} from '@/services/orbitServerApi';
import { notifyToast } from '@/services/orbitToast';
import { useOrbitStore } from '@/stores/useOrbitStore';
import styles from './Inbox.module.css';

type ChannelKey =
  | 'ALL'
  | 'announcements'
  | 'lec-doc'
  | 'lec-punch'
  | 'lec-drive'
  | 'lec-oj'
  | 'lec-sso'
  | 'orbit';

interface AppChannelMeta {
  id: ChannelKey;
  name: string;
  subtitle: string;
  icon: ReactNode;
  accentClass: string;
  group: 'overview' | 'apps';
}

const APP_CHANNELS: readonly AppChannelMeta[] = [
  {
    id: 'ALL',
    name: '全部消息',
    subtitle: '聚合所有应用动态',
    icon: <Inbox size={15} />,
    accentClass: 'iconAll',
    group: 'overview',
  },
  {
    id: 'announcements',
    name: '工作室公告',
    subtitle: '队长发布 · 已读回执',
    icon: <Megaphone size={15} />,
    accentClass: 'iconAnn',
    group: 'overview',
  },
  {
    id: 'lec-doc',
    name: '乐程云文档',
    subtitle: 'LecDoc · 权限审批',
    icon: <BookOpen size={15} />,
    accentClass: 'iconDoc',
    group: 'apps',
  },
  {
    id: 'lec-punch',
    name: '考勤打卡',
    subtitle: 'LecPunch · 考核提醒',
    icon: <Clock3 size={15} />,
    accentClass: 'iconPunch',
    group: 'apps',
  },
  {
    id: 'lec-drive',
    name: '云盘素材',
    subtitle: 'LecDrive · 资源更新',
    icon: <HardDrive size={15} />,
    accentClass: 'iconDrive',
    group: 'apps',
  },
  {
    id: 'lec-oj',
    name: '在线判题',
    subtitle: 'LecOJ · 题库与竞赛',
    icon: <Code2 size={15} />,
    accentClass: 'iconOj',
    group: 'apps',
  },
  {
    id: 'lec-sso',
    name: '统一身份',
    subtitle: 'LecSSO · 安全提醒',
    icon: <ShieldCheck size={15} />,
    accentClass: 'iconSso',
    group: 'apps',
  },
  {
    id: 'orbit',
    name: 'Orbit 伴程',
    subtitle: '客户端更新与提醒',
    icon: <img src="./icon.png" alt="" style={{ width: '100%', height: '100%', display: 'block' }} />,
    accentClass: 'iconOrbit',
    group: 'apps',
  },
];

const SOURCE_LABELS: Record<string, string> = {
  'lec-doc': '乐程云文档',
  'lec-punch': '考勤打卡',
  'lec-drive': '云盘素材',
  'lec-oj': '在线判题',
  'lec-sso': '统一身份',
  orbit: 'Orbit 伴程',
};

function sourceTagLabel(sourceApp: string): string {
  return SOURCE_LABELS[sourceApp.toLowerCase()] ?? sourceApp;
}

export function InboxPage(): JSX.Element {
  const auth = useOrbitStore((s) => s.auth);
  const punchNotifications = useOrbitStore((s) => s.notifications);
  const ackPunchNotification = useOrbitStore((s) => s.ackNotification);
  const orbitServerOnline = useOrbitStore((s) => s.orbitServerOnline);
  const orbitAnnouncements = useOrbitStore((s) => s.orbitAnnouncements);
  const orbitNotifications = useOrbitStore((s) => s.orbitNotifications);
  const refreshOrbitCenter = useOrbitStore((s) => s.refreshOrbitCenter);
  const setActiveTab = useOrbitStore((s) => s.setActiveTab);

  const [activeChannel, setActiveChannel] = useState<ChannelKey>('ALL');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);

  // 公告详情弹窗（打开后自动触发 IM 已读回执）
  const [viewingAnn, setViewingAnn] = useState<OrbitAnnouncement | null>(null);

  // IM 全员已读/未读名单弹窗（所有成员可见）
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const [receiptsLoading, setReceiptsLoading] = useState(false);
  const [receiptsData, setReceiptsData] = useState<OrbitAnnouncementReceipts | null>(null);
  const [receiptsTab, setReceiptsTab] = useState<'read' | 'unread'>('read');
  const [reminding, setReminding] = useState(false);

  // 队长富文本公告编辑器弹窗
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editorTitle, setEditorTitle] = useState('');
  const [editorPinned, setEditorPinned] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorUploadingImg, setEditorUploadingImg] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void refreshOrbitCenter();
  }, [refreshOrbitCenter]);

  // 成员打开公告详情后自动记录已读回执（幂等 + WS 实时广播全员刷新计数）
  useEffect(() => {
    if (!viewingAnn || viewingAnn.isReadByMe) return;
    const timer = setTimeout(() => {
      void orbitServerApi
        .markAnnouncementRead(viewingAnn.id)
        .then((res) => {
          setViewingAnn((prev) =>
            prev && prev.id === viewingAnn.id
              ? { ...prev, isReadByMe: true, readCount: res.readCount, totalCount: res.totalCount }
              : prev,
          );
        })
        .catch(() => undefined);
    }, 600);
    return () => clearTimeout(timer);
  }, [viewingAnn]);

  const openReceiptsModal = async (annId: string) => {
    setReceiptsOpen(true);
    setReceiptsLoading(true);
    setReceiptsTab('read');
    try {
      const data = await orbitServerApi.getAnnouncementReceipts(annId);
      setReceiptsData(data);
    } catch (err) {
      notifyToast({
        tone: 'error',
        title: '获取已读清单失败',
        description: err instanceof Error ? err.message : '请稍后重试。',
      });
      setReceiptsOpen(false);
    } finally {
      setReceiptsLoading(false);
    }
  };

  const handleRemindUnread = async () => {
    if (!receiptsData || reminding) return;
    setReminding(true);
    try {
      const res = await orbitServerApi.remindUnread(receiptsData.announcementId);
      notifyToast({
        tone: 'success',
        title: '提醒已发送',
        description:
          res.remindedCount > 0
            ? `已向 ${res.remindedCount} 位未读成员发送 Orbit 提醒。`
            : '全员均已阅读该公告，无需提醒。',
      });
    } catch (err) {
      notifyToast({
        tone: 'error',
        title: '发送提醒失败',
        description: err instanceof Error ? err.message : '请稍后重试。',
      });
    } finally {
      setReminding(false);
    }
  };

  const openEditor = (existing?: OrbitAnnouncement) => {
    setEditingId(existing?.id ?? null);
    setEditorTitle(existing?.title ?? '');
    setEditorPinned(existing?.pinned ?? false);
    setEditorError(null);
    setEditorOpen(true);
    setTimeout(() => {
      if (editorRef.current) {
        editorRef.current.innerHTML = existing?.contentHtml ?? '<p></p>';
        editorRef.current.focus();
      }
    }, 30);
  };

  const execEditorCmd = (cmd: string, value?: string) => {
    editorRef.current?.focus();
    document.execCommand(cmd, false, value);
  };

  const handleInsertLink = () => {
    const url = window.prompt('请输入要插入的链接（https://...）');
    if (!url || (!url.startsWith('https://') && !url.startsWith('http://'))) return;
    execEditorCmd('createLink', url);
  };

  const handleImageFilePicked = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setEditorUploadingImg(true);
    setEditorError(null);
    try {
      const url = await orbitServerApi.uploadAnnouncementImage(file);
      execEditorCmd('insertImage', url);
      notifyToast({ tone: 'success', title: '图片已上传至统一 RustFS', description: url });
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : '上传插图失败');
    } finally {
      setEditorUploadingImg(false);
    }
  };

  const handleSaveAnnouncement = async () => {
    const title = editorTitle.trim();
    const html = editorRef.current?.innerHTML?.trim() ?? '';
    if (!title || !html || html === '<p></p>' || html === '<br>') {
      setEditorError('请填写公告标题与正文内容。');
      return;
    }
    setEditorSaving(true);
    setEditorError(null);
    try {
      if (editingId) {
        await orbitServerApi.updateAnnouncement(editingId, {
          title,
          contentHtml: html,
          pinned: editorPinned,
        });
        notifyToast({ tone: 'success', title: '公告已更新并实时推送' });
      } else {
        await orbitServerApi.createAnnouncement({
          title,
          contentHtml: html,
          pinned: editorPinned,
        });
        notifyToast({ tone: 'success', title: '公告已发布并推送给全员' });
      }
      setEditorOpen(false);
      await refreshOrbitCenter();
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : '保存公告失败');
    } finally {
      setEditorSaving(false);
    }
  };

  const handleDeleteAnnouncement = async (id: string) => {
    try {
      await orbitServerApi.deleteAnnouncement(id);
      if (viewingAnn?.id === id) setViewingAnn(null);
      notifyToast({ tone: 'info', title: '公告已撤回删除' });
      await refreshOrbitCenter();
    } catch (err) {
      notifyToast({
        tone: 'error',
        title: '删除公告失败',
        description: err instanceof Error ? err.message : '请稍后重试。',
      });
    }
  };

  const handleMarkOrbitNotifRead = async (id: string) => {
    try {
      await orbitServerApi.markNotificationRead(id);
      await refreshOrbitCenter();
    } catch {
      // 忽略瞬时错误
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await orbitServerApi.markAllNotificationsRead();
      await refreshOrbitCenter();
      notifyToast({ tone: 'success', title: '已全部标为已读' });
    } catch (err) {
      notifyToast({
        tone: 'error',
        title: '操作失败',
        description: err instanceof Error ? err.message : '请稍后重试。',
      });
    }
  };

  const handleApprovalDecision = async (
    notif: OrbitNotificationItem,
    decision: 'approve' | 'deny',
  ) => {
    setBusyActionId(`${notif.id}:${decision}`);
    try {
      await orbitServerApi.handleNotificationAction(notif.id, decision);
      notifyToast({
        tone: decision === 'approve' ? 'success' : 'info',
        title: decision === 'approve' ? '已同意编辑权限' : '已拒绝该申请',
        description:
          decision === 'approve'
            ? '已自动为对方授予云文档编辑权并回推通知。'
            : '已通知申请人审批结果。',
      });
      await refreshOrbitCenter();
    } catch (err) {
      notifyToast({
        tone: 'error',
        title: '审批操作失败',
        description: err instanceof Error ? err.message : '请稍后重试。',
      });
    } finally {
      setBusyActionId(null);
    }
  };

  // 合并 Orbit Go 后端通知 + LecPunch 既有考勤通知
  const allNotifications = useMemo(() => {
    const punchMapped: Array<OrbitNotificationItem & { legacyPunch?: boolean }> =
      punchNotifications.map((p) => ({
        id: `punch:${p.id}`,
        sourceApp: 'lec-punch',
        eventType: p.type || 'punch.notice',
        title: p.title,
        body: p.body,
        payload: { legacyId: p.id },
        isRead: p.status === 'acknowledged' || p.status === 'read',
        createdAt: p.createdAt,
        legacyPunch: true,
      }));
    const combined: Array<OrbitNotificationItem & { legacyPunch?: boolean }> = [
      ...orbitNotifications,
      ...punchMapped,
    ];
    combined.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return combined;
  }, [orbitNotifications, punchNotifications]);

  // 计算每个应用频道的未读角标数
  const unreadByChannel = useMemo(() => {
    const counts: Record<ChannelKey, number> = {
      ALL: 0,
      announcements: 0,
      'lec-doc': 0,
      'lec-punch': 0,
      'lec-drive': 0,
      'lec-oj': 0,
      'lec-sso': 0,
      orbit: 0,
    };
    counts.announcements = orbitAnnouncements.filter((a) => !a.isReadByMe).length;
    for (const n of allNotifications) {
      if (n.isRead) continue;
      counts.ALL += 1;
      const key = n.sourceApp.toLowerCase() as ChannelKey;
      if (key in counts) {
        counts[key] += 1;
      }
    }
    return counts;
  }, [allNotifications, orbitAnnouncements]);

  const visibleNotifications = useMemo(() => {
    return allNotifications.filter((item) => {
      if (unreadOnly && item.isRead) return false;
      if (activeChannel !== 'ALL' && activeChannel !== 'announcements') {
        if (item.sourceApp.toLowerCase() !== activeChannel) return false;
      }
      return true;
    });
  }, [allNotifications, activeChannel, unreadOnly]);

  const currentMeta =
    APP_CHANNELS.find((c) => c.id === activeChannel) ?? APP_CHANNELS[0]!;
  const overviewChannels = APP_CHANNELS.filter((c) => c.group === 'overview');
  const appChannels = APP_CHANNELS.filter((c) => c.group === 'apps');

  return (
    <div className={styles.splitPage}>
      {/* 左侧竖向「应用 Icon + 名称」频道列表 */}
      <aside className={styles.channelRail} aria-label="通知应用频道">
        <div className={styles.railHeader}>
          <h2 className={styles.railTitle}>通知中心</h2>
        </div>

        <div className={styles.railGroup}>
          <div className={styles.railGroupLabel}>总览</div>
          {overviewChannels.map((ch) => {
            const count = unreadByChannel[ch.id];
            return (
              <button
                key={ch.id}
                type="button"
                className={`${styles.channelItem} ${
                  activeChannel === ch.id ? styles.channelItemActive : ''
                }`}
                onClick={() => setActiveChannel(ch.id)}
              >
                <span className={`${styles.appIcon} ${styles[ch.accentClass]}`}>{ch.icon}</span>
                <span className={styles.channelText}>
                  <span className={styles.channelName}>{ch.name}</span>
                  <span className={styles.channelSub}>{ch.subtitle}</span>
                </span>
                {count > 0 && <Badge count={count} />}
              </button>
            );
          })}
        </div>

        <div className={styles.railGroup}>
          <div className={styles.railGroupLabel}>接入应用</div>
          {appChannels.map((ch) => {
            const count = unreadByChannel[ch.id];
            return (
              <button
                key={ch.id}
                type="button"
                className={`${styles.channelItem} ${
                  activeChannel === ch.id ? styles.channelItemActive : ''
                }`}
                onClick={() => setActiveChannel(ch.id)}
              >
                <span className={`${styles.appIcon} ${styles[ch.accentClass]}`}>{ch.icon}</span>
                <span className={styles.channelText}>
                  <span className={styles.channelName}>{ch.name}</span>
                  <span className={styles.channelSub}>{ch.subtitle}</span>
                </span>
                {count > 0 && <Badge count={count} />}
              </button>
            );
          })}
        </div>
      </aside>

      {/* 右侧内容区 */}
      <section className={styles.mainPane}>
        <header className={styles.paneHeader}>
          <div className={styles.paneTitleGroup}>
            <span className={`${styles.appIcon} ${styles.appIconLg} ${styles[currentMeta.accentClass]}`}>
              {currentMeta.icon}
            </span>
            <div>
              <h1 className={styles.heading}>{currentMeta.name}</h1>
              <p className={styles.subheading}>{currentMeta.subtitle}</p>
            </div>
          </div>

          <div className={styles.headerActions}>
            {activeChannel === 'announcements' ? (
              auth.isAdmin && (
                <Button
                  variant="filled"
                  size="small"
                  icon={<Plus size={14} />}
                  onClick={() => openEditor()}
                >
                  发布公告
                </Button>
              )
            ) : (
              <>
                <label className={styles.unreadToggle}>
                  <span>仅未读</span>
                  <Switch checked={unreadOnly} onCheckedChange={setUnreadOnly} />
                </label>
                {orbitNotifications.some((n) => !n.isRead) && (
                  <Button
                    variant="glass"
                    size="small"
                    icon={<CheckCheck size={14} />}
                    onClick={() => void handleMarkAllRead()}
                  >
                    全部已读
                  </Button>
                )}
              </>
            )}
          </div>
        </header>

        {!orbitServerOnline && (
          <Message tone="info">
            Orbit 实时通知服务暂未连接，当前优先展示已同步的本地考勤消息。
          </Message>
        )}

        <div className={styles.paneBody}>
          {activeChannel === 'announcements' ? (
            <div className={styles.annList}>
              {orbitAnnouncements.length === 0 ? (
                <Card>
                  <Empty
                    title="暂无工作室公告"
                    description={
                      auth.isAdmin
                        ? '点击右上角「发布公告」，可使用富文本编辑并追踪全员已读/未读回执。'
                        : '队长发布新公告后会第一时间推送到这里。'
                    }
                  />
                </Card>
              ) : (
                orbitAnnouncements.map((ann) => (
                  <Card key={ann.id} className={styles.annCard}>
                    <div className={styles.annTop} onClick={() => setViewingAnn(ann)}>
                      <div className={styles.annTitleRow}>
                        {ann.pinned && (
                          <Tag tone="warning">
                            <Pin size={11} style={{ marginRight: 3 }} />
                            置顶
                          </Tag>
                        )}
                        {!ann.isReadByMe && <span className={styles.unreadDot} title="未读" />}
                        <h3 className={styles.annTitle}>{ann.title}</h3>
                      </div>
                      <p className={styles.annExcerpt}>{ann.contentText}</p>
                    </div>

                    <div className={styles.annFooter}>
                      <div className={styles.annAuthor}>
                        <Avatar src={ann.authorAvatar} name={ann.authorName || '队长'} size="small" />
                        <span>{ann.authorName || '队长'}</span>
                        <span className={styles.dotSep}>·</span>
                        <span>{new Date(ann.createdAt).toLocaleString('zh-CN')}</span>
                      </div>

                      <div className={styles.annFooterRight}>
                        <button
                          type="button"
                          className={styles.receiptPill}
                          onClick={() => void openReceiptsModal(ann.id)}
                          title="查看全员已读 / 未读明细"
                        >
                          <Eye size={13} />
                          <span>
                            {ann.readCount}/{ann.totalCount} 已读
                          </span>
                        </button>
                        <Button variant="glass" size="small" onClick={() => setViewingAnn(ann)}>
                          阅读全文
                        </Button>
                        {auth.isAdmin && (
                          <>
                            <Button
                              variant="glass"
                              size="small"
                              icon={<Pencil size={13} />}
                              onClick={() => openEditor(ann)}
                            >
                              编辑
                            </Button>
                            <Button
                              variant="glass"
                              size="small"
                              destructive
                              icon={<Trash2 size={13} />}
                              onClick={() => void handleDeleteAnnouncement(ann.id)}
                            >
                              删除
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  </Card>
                ))
              )}
            </div>
          ) : visibleNotifications.length === 0 ? (
            <Card>
              <Empty
                title={`「${currentMeta.name}」暂无消息`}
                description="该应用发版更新、权限申请或实时动态会第一时间推送到这里。"
              />
            </Card>
          ) : (
            <Card className={styles.feedCard}>
              <ul className={styles.list}>
                {visibleNotifications.map((item) => {
                  const isDocRequest = item.eventType === 'doc.edit_request';
                  const pageUrl =
                    typeof item.payload?.pageUrl === 'string' ? item.payload.pageUrl : undefined;
                  const chMeta = APP_CHANNELS.find(
                    (c) => c.id === item.sourceApp.toLowerCase(),
                  );
                  return (
                    <li key={item.id} className={styles.item}>
                      <div className={styles.itemLeft}>
                        <span
                          className={`${styles.appIcon} ${styles.appIconSm} ${
                            styles[chMeta?.accentClass ?? 'iconAll']
                          }`}
                        >
                          {chMeta?.icon ?? <Inbox size={13} />}
                        </span>
                        <div className={styles.itemMain}>
                          <div className={styles.itemHead}>
                            <span className={styles.itemTitle}>{item.title}</span>
                            {activeChannel === 'ALL' && (
                              <Tag tone="info">{sourceTagLabel(item.sourceApp)}</Tag>
                            )}
                            {!item.isRead && <span className={styles.unreadDot} title="未读" />}
                            {item.actionStatus === 'approved' && <Tag tone="success">已同意</Tag>}
                            {item.actionStatus === 'denied' && <Tag tone="danger">已拒绝</Tag>}
                          </div>
                          <p className={styles.itemBody}>{item.body}</p>
                          <span className={styles.itemTime}>
                            {new Date(item.createdAt).toLocaleString('zh-CN')}
                          </span>
                        </div>
                      </div>

                      <div className={styles.itemActions}>
                        {isDocRequest && item.actionStatus === 'pending' && (
                          <>
                            <Button
                              variant="filled"
                              size="small"
                              icon={<Check size={14} />}
                              loading={busyActionId === `${item.id}:approve`}
                              disabled={Boolean(busyActionId)}
                              onClick={() => void handleApprovalDecision(item, 'approve')}
                            >
                              同意编辑
                            </Button>
                            <Button
                              variant="glass"
                              size="small"
                              destructive
                              icon={<X size={14} />}
                              loading={busyActionId === `${item.id}:deny`}
                              disabled={Boolean(busyActionId)}
                              onClick={() => void handleApprovalDecision(item, 'deny')}
                            >
                              拒绝
                            </Button>
                          </>
                        )}
                        {pageUrl && (
                          <Button
                            variant="glass"
                            size="small"
                            onClick={() => setActiveTab('doc')}
                          >
                            查看文档
                          </Button>
                        )}
                        {!item.isRead && (!isDocRequest || item.actionStatus !== 'pending') && (
                          <Button
                            variant="glass"
                            size="small"
                            icon={<Check size={14} />}
                            onClick={() => {
                              if (item.legacyPunch) {
                                const rawId = String(item.payload?.legacyId ?? '');
                                if (rawId) void ackPunchNotification(rawId);
                              } else {
                                void handleMarkOrbitNotifRead(item.id);
                              }
                            }}
                          >
                            标为已读
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </div>
      </section>

      {/* 公告阅读全文弹窗 */}
      <Dialog
        open={Boolean(viewingAnn)}
        onOpenChange={(open) => !open && setViewingAnn(null)}
        size="large"
        title={viewingAnn?.title ?? '公告详情'}
        description={
          viewingAnn
            ? `${viewingAnn.authorName} 发布于 ${new Date(viewingAnn.createdAt).toLocaleString('zh-CN')}`
            : undefined
        }
      >
        {viewingAnn && (
          <div className={styles.annDetailWrap}>
            <div
              className={styles.richContent}
              dangerouslySetInnerHTML={{ __html: viewingAnn.contentHtml }}
            />
            <div className={styles.annDetailFooter}>
              <button
                type="button"
                className={styles.receiptPill}
                onClick={() => void openReceiptsModal(viewingAnn.id)}
              >
                <Eye size={13} />
                <span>
                  {viewingAnn.readCount}/{viewingAnn.totalCount} 人已读 · 点击查看明细
                </span>
              </button>
              <Button variant="filled" size="small" onClick={() => setViewingAnn(null)}>
                关闭
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      {/* IM 风格全员已读/未读清单弹窗（所有成员可见） */}
      <Dialog
        open={receiptsOpen}
        onOpenChange={setReceiptsOpen}
        size="regular"
        title="公告阅读回执"
        description={
          receiptsData
            ? `共 ${receiptsData.totalCount} 位工作室成员 · ${receiptsData.readCount} 人已读，${receiptsData.unreadCount} 人未读`
            : '正在加载成员阅读回执…'
        }
      >
        {receiptsLoading ? (
          <div className={styles.receiptLoading}>正在加载已读/未读成员列表…</div>
        ) : receiptsData ? (
          <div className={styles.receiptModalBody}>
            <div className={styles.receiptToolbar}>
              <SegmentedControl
                value={receiptsTab}
                onValueChange={(v) => setReceiptsTab(v as 'read' | 'unread')}
                items={[
                  { value: 'read', label: `已读 (${receiptsData.readCount})` },
                  { value: 'unread', label: `未读 (${receiptsData.unreadCount})` },
                ]}
              />
              {auth.isAdmin && receiptsData.unreadCount > 0 && (
                <Button
                  variant="filled"
                  size="small"
                  icon={<BellRing size={13} />}
                  loading={reminding}
                  onClick={() => void handleRemindUnread()}
                >
                  提醒未读成员
                </Button>
              )}
            </div>

            <div className={styles.receiptList}>
              {(receiptsTab === 'read' ? receiptsData.read : receiptsData.unread).length === 0 ? (
                <Empty
                  title={receiptsTab === 'read' ? '暂无人阅读' : '全员均已读'}
                  description={
                    receiptsTab === 'read' ? '等待成员打开查阅' : '所有工作室成员均已确认该公告'
                  }
                />
              ) : (
                (receiptsTab === 'read' ? receiptsData.read : receiptsData.unread).map((m) => (
                  <div key={m.userId} className={styles.receiptRow}>
                    <Avatar src={m.avatar} name={m.displayName || m.username} size="small" />
                    <div className={styles.receiptUserInfo}>
                      <span className={styles.receiptUserName}>{m.displayName || m.username}</span>
                      {m.username && <span className={styles.receiptUserHandle}>@{m.username}</span>}
                    </div>
                    {m.readAt ? (
                      <span className={styles.receiptTime}>
                        {new Date(m.readAt).toLocaleString('zh-CN', {
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    ) : (
                      <Tag tone="neutral">未读</Tag>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        ) : null}
      </Dialog>

      {/* 队长富文本公告编辑器弹窗 */}
      <Dialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        size="large"
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Megaphone size={16} />
            {editingId ? '编辑工作室公告' : '发布工作室公告'}
          </span>
        }
        description="支持富文本排版与配图（直传统一 RustFS），发布后实时推送给全体成员并开启已读追踪。"
      >
        <div className={styles.editorWrap}>
          <Input
            variant="fill"
            placeholder="输入公告标题（例如：第 12 周工作室例会与考核安排）"
            value={editorTitle}
            onValueChange={setEditorTitle}
            disabled={editorSaving}
          />

          <div className={styles.editorToolbar}>
            <button type="button" className={styles.toolBtn} title="小标题" onClick={() => execEditorCmd('formatBlock', 'h2')}>
              <Heading2 size={15} />
            </button>
            <button type="button" className={styles.toolBtn} title="加粗" onClick={() => execEditorCmd('bold')}>
              <Bold size={15} />
            </button>
            <button type="button" className={styles.toolBtn} title="斜体" onClick={() => execEditorCmd('italic')}>
              <Italic size={15} />
            </button>
            <button type="button" className={styles.toolBtn} title="下划线" onClick={() => execEditorCmd('underline')}>
              <Underline size={15} />
            </button>
            <button type="button" className={styles.toolBtn} title="无序列表" onClick={() => execEditorCmd('insertUnorderedList')}>
              <List size={15} />
            </button>
            <button type="button" className={styles.toolBtn} title="有序列表" onClick={() => execEditorCmd('insertOrderedList')}>
              <ListOrdered size={15} />
            </button>
            <button type="button" className={styles.toolBtn} title="引用块" onClick={() => execEditorCmd('formatBlock', 'blockquote')}>
              <Quote size={15} />
            </button>
            <button type="button" className={styles.toolBtn} title="代码块" onClick={() => execEditorCmd('formatBlock', 'pre')}>
              <Code size={15} />
            </button>
            <button type="button" className={styles.toolBtn} title="插入链接" onClick={handleInsertLink}>
              <Link2 size={15} />
            </button>
            <button
              type="button"
              className={styles.toolBtn}
              title="上传并插入图片"
              disabled={editorUploadingImg}
              onClick={() => fileInputRef.current?.click()}
            >
              <ImagePlus size={15} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              style={{ display: 'none' }}
              onChange={(e) => void handleImageFilePicked(e)}
            />
            <label className={styles.pinSwitch}>
              <span>置顶</span>
              <Switch checked={editorPinned} onCheckedChange={setEditorPinned} />
            </label>
          </div>

          <div
            ref={editorRef}
            className={`${styles.editorSurface} ${styles.richContent}`}
            contentEditable
            suppressContentEditableWarning
            data-placeholder="在这里撰写公告正文，支持直接格式化与插入图片…"
          />

          {editorError && <Message tone="error">{editorError}</Message>}

          <div className={styles.editorFooter}>
            <Button variant="glass" size="small" onClick={() => setEditorOpen(false)} disabled={editorSaving}>
              取消
            </Button>
            <Button
              variant="filled"
              size="small"
              loading={editorSaving}
              onClick={() => void handleSaveAnnouncement()}
            >
              {editingId ? '保存修改' : '发布并推送全员'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
