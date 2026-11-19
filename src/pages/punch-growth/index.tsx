/** LecPunch 成长与记录页：分段切换「打卡日历」「积分与考核」「周报工作台（SQLite 防丢草稿）」。 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  ActivityCalendar,
  Button,
  Card,
  Empty,
  SegmentedControl,
  Statistic,
  Tag,
  TextArea,
  type ActivityDay,
} from '@lec-space/liquidglass';
import { Save } from '@lec-space/icons';
import { formatReadableDuration, getCurrentIsoWeek } from '@shared/punch';
import { getOrbitClient } from '@/services/orbitClient';
import { notifyToast } from '@/services/orbitToast';
import { punchApi } from '@/services/punchApi';
import { useOrbitStore } from '@/stores/useOrbitStore';
import styles from './PunchGrowth.module.css';

type GrowthSegment = 'calendar' | 'assessment' | 'report';

function currentYearMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function PunchGrowthPage(): JSX.Element {
  const auth = useOrbitStore((s) => s.auth);
  const records = useOrbitStore((s) => s.records);
  const weeklyStats = useOrbitStore((s) => s.weeklyStats);
  const points = useOrbitStore((s) => s.points);

  const [segment, setSegment] = useState<GrowthSegment>('calendar');
  const [month, setMonth] = useState(currentYearMonth);
  const [selectedDate, setSelectedDate] = useState(todayIso);

  const currentWeek = useMemo(() => getCurrentIsoWeek(), []);
  const [reportText, setReportText] = useState('');
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const [submittingReport, setSubmittingReport] = useState(false);

  // 加载本地 SQLite 周报草稿（断网/关机防丢失）并尝试与远端合并
  useEffect(() => {
    let active = true;
    void (async () => {
      const local = await getOrbitClient().storage.getWeeklyDraft(currentWeek);
      if (active && local) {
        setReportText(local.content);
        setDraftSavedAt(local.updatedAt);
      }
      if (auth.authenticated) {
        const remote = await punchApi.fetchWeeklyReport(currentWeek).catch(() => null);
        if (active && remote?.content && (!local || !local.content.trim())) {
          setReportText(remote.content);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [currentWeek, auth.authenticated]);

  // 防抖自动写入 L3 SQLite 本地草稿
  useEffect(() => {
    if (!reportText) return;
    const timer = window.setTimeout(() => {
      void getOrbitClient()
        .storage.saveWeeklyDraft(currentWeek, reportText)
        .then((saved) => setDraftSavedAt(saved.updatedAt));
    }, 600);
    return () => window.clearTimeout(timer);
  }, [reportText, currentWeek]);

  const calendarDays = useMemo<ActivityDay[]>(() => {
    const byDate = new Map<string, number>();
    for (const rec of records) {
      const key = (rec.date ?? rec.checkInTime).slice(0, 10);
      byDate.set(key, (byDate.get(key) ?? 0) + rec.durationSeconds);
    }
    return [...byDate.entries()].map(([date, secs]) => ({
      date,
      value: Math.round(secs / 60),
      label: `${date} · ${formatReadableDuration(secs)}`,
    }));
  }, [records]);

  const handleSubmitReport = async () => {
    if (!reportText.trim()) return;
    setSubmittingReport(true);
    try {
      await getOrbitClient().storage.saveWeeklyDraft(currentWeek, reportText);
      await punchApi.saveWeeklyReport(currentWeek, reportText);
      notifyToast({
        tone: 'success',
        title: '周报已提交',
        description: '已同步至 LecPunch 服务端，并保留本地 SQLite 备份。',
      });
    } catch (err) {
      notifyToast({
        tone: 'error',
        title: '周报提交失败（草稿已安全保留）',
        description: err instanceof Error ? err.message : '请检查网络连接后重试。',
      });
    } finally {
      setSubmittingReport(false);
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.heading}>成长与记录</h1>
          <p className={styles.subheading}>打卡热力图、每周考核趋势与本地防丢周报工作台</p>
        </div>
        <SegmentedControl
          value={segment}
          onValueChange={(v) => setSegment(v as GrowthSegment)}
          items={[
            { value: 'calendar', label: '打卡日历' },
            { value: 'assessment', label: '考核与积分' },
            { value: 'report', label: '周报工作台' },
          ]}
        />
      </header>

      {segment === 'calendar' && (
        <div className={styles.twoCol}>
          <ActivityCalendar
            month={month}
            days={calendarDays}
            today={todayIso()}
            selectedDate={selectedDate}
            onDateSelect={setSelectedDate}
            onMonthChange={setMonth}
            aria-label="月度考勤打卡热力图"
          />
          <Card title={`近期打卡明细（${records.length} 条）`}>
            {records.length === 0 ? (
              <Empty title="暂无打卡记录" description="完成一次签退后将在此展示" />
            ) : (
              <ul className={styles.recordList}>
                {records.slice(0, 12).map((item) => (
                  <li key={item.id} className={styles.recordRow}>
                    <div>
                      <div className={styles.recordDate}>
                        {new Date(item.checkInTime).toLocaleDateString('zh-CN')}
                      </div>
                      <div className={styles.recordTime}>
                        {new Date(item.checkInTime).toLocaleTimeString('zh-CN', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                        {' — '}
                        {item.checkOutTime
                          ? new Date(item.checkOutTime).toLocaleTimeString('zh-CN', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : '进行中'}
                      </div>
                    </div>
                    <Tag tone="info">{formatReadableDuration(item.durationSeconds)}</Tag>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {segment === 'assessment' && (
        <div className={styles.metricGrid}>
          <Card title="本周累计专注">
            <Statistic
              title={weeklyStats?.week ?? currentWeek}
              value={formatReadableDuration(weeklyStats?.totalDurationSeconds ?? 0)}
            />
          </Card>
          <Card title="考核达标状态">
            <Tag tone={weeklyStats?.qualified ? 'success' : 'warning'}>
              {weeklyStats?.qualified ? '本周已达标' : '继续加油，尚未达标'}
            </Tag>
            <p className={styles.muted}>
              目标时长：{formatReadableDuration(weeklyStats?.targetDurationSeconds ?? 18 * 3600)}
            </p>
          </Card>
          <Card title="积分与卡牌">
            <Statistic title="当前积分" value={points?.totalPoints ?? 0} suffix="分" />
            <p className={styles.muted}>持有卡牌：{points?.cardsCount ?? 0} 张</p>
          </Card>
        </div>
      )}

      {segment === 'report' && (
        <Card
          title={`本周周报（${currentWeek}）`}
          description={
            draftSavedAt
              ? `SQLite 本地草稿已自动保存于 ${new Date(draftSavedAt).toLocaleTimeString('zh-CN')}`
              : '输入内容将自动防抖保存至本地 SQLite，断网或重启不丢字'
          }
          extra={
            <Button
              variant="filled"
              size="small"
              icon={<Save size={15} />}
              loading={submittingReport}
              disabled={!auth.authenticated || !reportText.trim()}
              onClick={handleSubmitReport}
            >
              提交周报
            </Button>
          }
        >
          <TextArea
            rows={12}
            placeholder="记录本周完成的代码提交、算法训练、文档沉淀与下周计划..."
            value={reportText}
            onValueChange={setReportText}
          />
        </Card>
      )}
    </div>
  );
}
