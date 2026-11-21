/** LecPunch 工作室动态页：团队本周榜单、团队活动及管理员快捷入口。 */
import { useState, type JSX } from 'react';
import { Avatar, Button, Card, Empty, SegmentedControl, Tag } from '@lec-space/liquidglass';
import { CalendarDays, ExternalLink, Trophy } from '@lec-space/icons';
import { getOrbitEndpoints } from '@shared/env';
import { formatReadableDuration } from '@shared/punch';
import { TitleBadgeList } from '@/components/TitleBadge';
import { getOrbitClient } from '@/services/orbitClient';
import { useOrbitStore } from '@/stores/useOrbitStore';
import styles from './PunchStudio.module.css';

type StudioSegment = 'ranking' | 'events';

export function PunchStudioPage(): JSX.Element {
  const auth = useOrbitStore((s) => s.auth);
  const ranking = useOrbitStore((s) => s.teamRanking);
  const events = useOrbitStore((s) => s.teamEvents);
  const [segment, setSegment] = useState<StudioSegment>('ranking');

  const openAdminInBrowser = () => {
    const base = getOrbitEndpoints().punchWebUrl;
    void getOrbitClient().system.openExternal(`${base}/admin-dashboard`);
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.heading}>工作室动态</h1>
          <p className={styles.subheading}>团队本周专注排行与近期工作室活动</p>
        </div>
        <div className={styles.actions}>
          {auth.isAdmin && (
            <Button
              variant="glass"
              size="small"
              icon={<ExternalLink size={14} />}
              onClick={openAdminInBrowser}
            >
              管理后台（浏览器）
            </Button>
          )}
          <SegmentedControl
            value={segment}
            onValueChange={(v) => setSegment(v as StudioSegment)}
            items={[
              { value: 'ranking', label: '团队周榜' },
              { value: 'events', label: '团队活动' },
            ]}
          />
        </div>
      </header>

      {segment === 'ranking' && (
        <Card
          title={
            <span className={styles.cardTitle}>
              <Trophy size={16} /> 本周专注排行榜
            </span>
          }
        >
          {ranking.length === 0 ? (
            <Empty title="暂无本周排行数据" description="登录后将自动同步团队本周专注排行" />
          ) : (
            <ol className={styles.rankList}>
              {ranking.map((item, idx) => (
                <li key={item.userId} className={styles.rankRow}>
                  <div className={styles.rankLeft}>
                    <span className={styles.rankIndex}>{item.rank ?? idx + 1}</span>
                    <Avatar src={item.avatar} name={item.realName || item.displayName} size="small" />
                    <div>
                      <div className={styles.rankNameRow}>
                        <span className={styles.rankName}>{item.displayName}</span>
                        <TitleBadgeList titles={item.titles} size="xs" maxVisible={3} />
                      </div>
                      <div className={styles.rankTeam}>{item.teamName || '工作室成员'}</div>
                    </div>
                  </div>
                  <div className={styles.rankRight}>
                    {item.qualified && <Tag tone="success">已达标</Tag>}
                    <span className={styles.rankDuration}>
                      {formatReadableDuration(item.totalDurationSeconds)}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Card>
      )}

      {segment === 'events' && (
        <Card
          title={
            <span className={styles.cardTitle}>
              <CalendarDays size={16} /> 工作室活动
            </span>
          }
        >
          {events.length === 0 ? (
            <Empty title="近期暂无公开活动" description="有新的技术分享或团建安排时会在此展示" />
          ) : (
            <ul className={styles.eventList}>
              {events.map((ev) => (
                <li key={ev.id} className={styles.eventRow}>
                  <div>
                    <div className={styles.eventTitle}>{ev.title}</div>
                    {ev.description && <p className={styles.eventDesc}>{ev.description}</p>}
                  </div>
                  <div className={styles.eventMeta}>
                    {ev.startTime && (
                      <Tag tone="neutral">{new Date(ev.startTime).toLocaleDateString('zh-CN')}</Tag>
                    )}
                    {ev.location && <Tag tone="info">{ev.location}</Tag>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
