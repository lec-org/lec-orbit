/**
 * LecPunch 成长与记录页（一页高密度总览 + 飞书式右侧极细图标栏与滑出侧栏）：
 * - 主区一页呈现：顶部 4 项核心指标条 + 左栏月度打卡热力图 + 右栏本周周报工作台（SQLite 防丢草稿）；
 * - 右边缘提供飞书风格竖排图标栏，按需滑出「打卡明细」「称号图鉴」「历史周考核」三类侧栏，避免多 Tab 分散与大片留白。
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  ActivityCalendar,
  Button,
  Empty,
  Tag,
  TextArea,
  type ActivityDay,
} from '@lec-space/liquidglass';
import { Save } from '@lec-space/icons';
import {
  Award,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Coins,
  Crown,
  FileText,
  Info,
  Moon,
  Sparkles,
  Star,
  Sun,
  Target,
  TrendingUp,
  X,
} from 'lucide-react';
import {
  computeTitleAchievementTier,
  formatReadableDuration,
  formatTitleTierText,
  getCurrentIsoWeek,
} from '@shared/punch';
import { TitleBadge, TitleBadgeList, TitleTierIcons } from '@/components/TitleBadge';
import { getOrbitClient } from '@/services/orbitClient';
import { notifyToast } from '@/services/orbitToast';
import { punchApi } from '@/services/punchApi';
import { useOrbitStore } from '@/stores/useOrbitStore';
import styles from './PunchGrowth.module.css';

type GrowthDrawerKind = 'records' | 'titles' | 'history' | null;

interface WeeklyHistoryItem {
  weekKey: string;
  totalDurationSeconds: number;
  weeklyGoalSeconds: number;
  assessmentComplete: boolean;
  sessionsCount: number;
}

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
  const myTitles = useOrbitStore((s) => s.myTitles);
  const equipTitle = useOrbitStore((s) => s.equipTitle);
  const setTitleVisibility = useOrbitStore((s) => s.setTitleVisibility);
  const segment = useOrbitStore((s) => s.growthSegment);
  const setSegment = useOrbitStore((s) => s.setGrowthSegment);

  const [drawer, setDrawer] = useState<GrowthDrawerKind>(null);
  const [recordFilterDate, setRecordFilterDate] = useState<string | null>(null);
  const [equippingId, setEquippingId] = useState<string | null>(null);
  const [tierRulesOpen, setTierRulesOpen] = useState(true);
  const [month, setMonth] = useState(currentYearMonth);
  const [selectedDate, setSelectedDate] = useState(todayIso);

  const [weeklyHistory, setWeeklyHistory] = useState<WeeklyHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const currentWeek = useMemo(() => getCurrentIsoWeek(), []);
  const [reportText, setReportText] = useState('');
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const [submittingReport, setSubmittingReport] = useState(false);

  // 兼容从工作室点击「我的称号」跳转：自动滑出右侧「称号图鉴」侧栏
  useEffect(() => {
    if (segment === 'titles') {
      setDrawer('titles');
      setSegment('calendar');
    } else if (segment === 'assessment') {
      setDrawer('history');
      setSegment('calendar');
    }
  }, [segment, setSegment]);

  // Esc 快捷键收起右侧滑出侧栏
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawer(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  // 展开历史周考核侧栏时按需加载多周历史数据
  useEffect(() => {
    if (drawer !== 'history' || !auth.authenticated) return;
    let cancelled = false;
    setHistoryLoading(true);
    void punchApi
      .fetchMyWeeklyHistory(12)
      .then((items) => {
        if (!cancelled) setWeeklyHistory(items);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [drawer, auth.authenticated]);

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

  const selectedDayRecords = useMemo(
    () => records.filter((rec) => (rec.date ?? rec.checkInTime).slice(0, 10) === selectedDate),
    [records, selectedDate],
  );

  const drawerRecords = useMemo(() => {
    if (!recordFilterDate) return records;
    return records.filter((rec) => (rec.date ?? rec.checkInTime).slice(0, 10) === recordFilterDate);
  }, [records, recordFilterDate]);

  const weekTotalSeconds = weeklyStats?.totalDurationSeconds ?? 0;
  const weekTargetSeconds = weeklyStats?.targetDurationSeconds ?? 18 * 3600;
  const progressPct =
    weekTargetSeconds > 0
      ? Math.min(100, Math.round((weekTotalSeconds / weekTargetSeconds) * 100))
      : 100;
  const remainingSeconds = Math.max(0, weekTargetSeconds - weekTotalSeconds);
  const unlockedTitleCount = myTitles?.catalog.filter((c) => c.unlocked).length ?? 0;
  const everAchievedTitleCount =
    myTitles?.catalog.filter((c) => c.unlocked || (c.unlockCount ?? 0) > 0).length ?? 0;
  const totalTitleCount = myTitles?.catalog.length ?? 0;
  const isTitleEligible = myTitles?.eligible !== false;

  const toggleDrawer = (kind: Exclude<GrowthDrawerKind, null>) => {
    if (drawer === kind) {
      setDrawer(null);
      return;
    }
    if (kind === 'records') {
      setRecordFilterDate(null);
    }
    setDrawer(kind);
  };

  const handleCalendarSelect = (date: string) => {
    setSelectedDate(date);
    const hasRecords = records.some((rec) => (rec.date ?? rec.checkInTime).slice(0, 10) === date);
    if (hasRecords) {
      setRecordFilterDate(date);
      setDrawer('records');
    }
  };

  const handleSubmitReport = async () => {
    if (!reportText.trim()) return;
    setSubmittingReport(true);
    try {
      await getOrbitClient().storage.saveWeeklyDraft(currentWeek, reportText);
      await punchApi.saveWeeklyReport(currentWeek, reportText);
      notifyToast({
        tone: 'success',
        title: '周报已提交',
        description: '已同步至服务端，并保留本地 SQLite 备份。',
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
    <div className={styles.shell}>
      {/* 主区：高密度一页总览 */}
      <div className={styles.workspace}>
        <header className={styles.header}>
          <div>
            <div className={styles.titleRow}>
              <h1 className={styles.heading}>成长与记录</h1>
              <span className={styles.weekPill}>{weeklyStats?.week ?? currentWeek}</span>
            </div>
            <p className={styles.subheading}>
              本周考核进度、打卡热力图与防丢周报一页总览 · 点击右上角或卡片可滑出右侧明细、称号图鉴与历史考核
            </p>
          </div>
          <div className={styles.headerQuickActions}>
            <button
              type="button"
              className={`${styles.quickChip} ${drawer === 'records' ? styles.quickChipActive : ''}`}
              onClick={() => toggleDrawer('records')}
            >
              <Clock size={13} />
              <span>打卡明细 ({records.length})</span>
            </button>
            <button
              type="button"
              className={`${styles.quickChip} ${drawer === 'titles' ? styles.quickChipActive : ''}`}
              onClick={() => toggleDrawer('titles')}
            >
              <Award size={13} />
              <span>称号图鉴</span>
            </button>
            <button
              type="button"
              className={`${styles.quickChip} ${drawer === 'history' ? styles.quickChipActive : ''}`}
              onClick={() => toggleDrawer('history')}
            >
              <TrendingUp size={13} />
              <span>历史考核</span>
            </button>
          </div>
        </header>

        {/* 顶部 4 卡紧凑指标条 */}
        <section className={styles.kpiStrip} aria-label="核心成长指标">
          <div className={styles.kpiCard}>
            <div className={styles.kpiHead}>
              <span className={styles.kpiLabel}>
                <Clock size={13} /> 本周累计专注
              </span>
              <span className={styles.kpiPct}>{progressPct}%</span>
            </div>
            <div className={styles.kpiValue}>{formatReadableDuration(weekTotalSeconds)}</div>
            <div className={styles.progressTrack} aria-hidden="true">
              <div
                className={`${styles.progressFill} ${weeklyStats?.qualified ? styles.progressFillDone : ''}`}
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>

          <div className={styles.kpiCard}>
            <div className={styles.kpiHead}>
              <span className={styles.kpiLabel}>
                <Target size={13} /> 考核状态
              </span>
              <span
                className={`${styles.statusPill} ${
                  weeklyStats?.qualified ? styles.statusPillDone : styles.statusPillPending
                }`}
              >
                {weeklyStats?.qualified ? '已达标' : '冲刺中'}
              </span>
            </div>
            <div className={styles.kpiValueSmall}>
              {weeklyStats?.qualified
                ? '本周考核已完成'
                : `距目标还差 ${formatReadableDuration(remainingSeconds)}`}
            </div>
            <div className={styles.kpiSub}>
              周目标 {formatReadableDuration(weekTargetSeconds)} · 点击右上查看历史
            </div>
          </div>

          <div className={styles.kpiCard}>
            <div className={styles.kpiHead}>
              <span className={styles.kpiLabel}>
                <Coins size={13} /> 乐币与卡牌
              </span>
            </div>
            <div className={styles.kpiValue}>
              {points?.totalPoints ?? 0}
              <span className={styles.kpiUnit}> 分</span>
            </div>
            <div className={styles.kpiSub}>当前持有卡牌 {points?.cardsCount ?? 0} 张</div>
          </div>

          <button
            type="button"
            className={`${styles.kpiCard} ${styles.kpiCardClickable}`}
            onClick={() => toggleDrawer('titles')}
          >
            <div className={styles.kpiHead}>
              <span className={styles.kpiLabel}>
                <Award size={13} /> 对外亮牌称号
              </span>
              {totalTitleCount > 0 && (
                <span className={styles.kpiHint}>
                  {isTitleEligible ? `${unlockedTitleCount}/${totalTitleCount}` : `图鉴 ${totalTitleCount} 项`}
                </span>
              )}
            </div>
            <div className={styles.kpiBadgesRow}>
              {myTitles && myTitles.displayTitles.length > 0 ? (
                <TitleBadgeList titles={myTitles.displayTitles} size="xs" maxVisible={2} />
              ) : (
                <span className={styles.kpiMuted}>
                  {!isTitleEligible ? '仅大一至大三参与评选' : '暂未点亮称号'}
                </span>
              )}
            </div>
            <div className={styles.kpiSub}>
              {isTitleEligible ? '点击展开右侧称号图鉴与佩戴设置 →' : '点击展开右侧浏览全部称号图鉴 →'}
            </div>
          </button>
        </section>

        {/* 主区双栏：左打卡热力图 + 右周报工作台 */}
        <div className={styles.bentoGrid}>
          <section className={`${styles.panel} ${styles.calendarPanel}`}>
            <div className={styles.panelHead}>
              <span className={styles.panelTitle}>月度打卡热力图</span>
              <button
                type="button"
                className={styles.panelLink}
                onClick={() => {
                  setRecordFilterDate(null);
                  setDrawer('records');
                }}
              >
                全部明细 ({records.length}) →
              </button>
            </div>
            <ActivityCalendar
              month={month}
              days={calendarDays}
              today={todayIso()}
              selectedDate={selectedDate}
              onDateSelect={handleCalendarSelect}
              onMonthChange={setMonth}
              aria-label="月度考勤打卡热力图"
            />
            <div className={styles.dayPreview}>
              <div className={styles.dayPreviewHead}>
                <span className={styles.dayPreviewTitle}>{selectedDate} 打卡摘要</span>
                {selectedDayRecords.length > 0 && (
                  <button
                    type="button"
                    className={styles.panelLink}
                    onClick={() => {
                      setRecordFilterDate(selectedDate);
                      setDrawer('records');
                    }}
                  >
                    侧栏展开 ({selectedDayRecords.length})
                  </button>
                )}
              </div>
              {selectedDayRecords.length === 0 ? (
                <div className={styles.dayPreviewEmpty}>当天暂无打卡记录，点击有色日期可快速查看</div>
              ) : (
                <div className={styles.dayPreviewList}>
                  {selectedDayRecords.slice(0, 3).map((rec) => (
                    <div key={rec.id} className={styles.dayPreviewRow}>
                      <span className={styles.dayPreviewTime}>
                        {new Date(rec.checkInTime).toLocaleTimeString('zh-CN', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                        {' — '}
                        {rec.checkOutTime
                          ? new Date(rec.checkOutTime).toLocaleTimeString('zh-CN', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : '进行中'}
                      </span>
                      <span className={styles.dayPreviewDur}>
                        {formatReadableDuration(rec.durationSeconds)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className={`${styles.panel} ${styles.reportPanel}`}>
            <div className={styles.panelHead}>
              <div className={styles.panelTitleWrap}>
                <span className={styles.panelTitle}>
                  <FileText size={14} /> 本周周报工作台（{currentWeek}）
                </span>
                <span className={styles.draftHint}>
                  {draftSavedAt
                    ? `SQLite 本地草稿自动保存于 ${new Date(draftSavedAt).toLocaleTimeString('zh-CN')}`
                    : '输入自动防抖保存至本地 SQLite，断网或重启不丢字'}
                </span>
              </div>
              <Button
                variant="filled"
                size="small"
                icon={<Save size={14} />}
                loading={submittingReport}
                disabled={!auth.authenticated || !reportText.trim()}
                onClick={() => void handleSubmitReport()}
              >
                提交周报
              </Button>
            </div>
            <div className={styles.reportBody}>
              <TextArea
                rows={13}
                placeholder="记录本周完成的代码提交、算法训练、文档沉淀与下周计划..."
                value={reportText}
                onValueChange={setReportText}
              />
            </div>
          </section>
        </div>
      </div>

      {/* 飞书式滑出右侧抽屉（点击右缘图标展开） */}
      {drawer !== null && (
        <aside className={styles.sideDrawer} aria-label="成长详情侧栏">
          <div className={styles.drawerHead}>
            <div className={styles.drawerTitle}>
              {drawer === 'records' && (
                <>
                  <Clock size={15} />
                  <span>{recordFilterDate ? `${recordFilterDate} 打卡明细` : '全部打卡明细'}</span>
                </>
              )}
              {drawer === 'titles' && (
                <>
                  <Award size={15} />
                  <span>工作室称号图鉴</span>
                </>
              )}
              {drawer === 'history' && (
                <>
                  <TrendingUp size={15} />
                  <span>历史周考核记录</span>
                </>
              )}
            </div>
            <div className={styles.drawerHeadRight}>
              {drawer === 'records' && recordFilterDate && (
                <button
                  type="button"
                  className={styles.panelLink}
                  onClick={() => setRecordFilterDate(null)}
                >
                  看全部
                </button>
              )}
              {drawer === 'titles' && myTitles?.equippedTitleId && (
                <Button
                  variant="glass"
                  size="small"
                  loading={equippingId === '__auto__'}
                  disabled={equippingId !== null && equippingId !== '__auto__'}
                  onClick={async () => {
                    if (equippingId !== null) return;
                    setEquippingId('__auto__');
                    try {
                      await equipTitle(null);
                    } finally {
                      setEquippingId(null);
                    }
                  }}
                >
                  恢复自动
                </Button>
              )}
              <button
                type="button"
                className={styles.drawerCloseBtn}
                aria-label="收起侧栏"
                onClick={() => setDrawer(null)}
              >
                <X size={15} />
              </button>
            </div>
          </div>

          <div className={styles.drawerBody}>
            {drawer === 'records' && (
              drawerRecords.length === 0 ? (
                <Empty
                  title="暂无打卡记录"
                  description={recordFilterDate ? '该日期下暂无签退记录' : '完成一次签退后将在此展示'}
                />
              ) : (
                <ul className={styles.recordList}>
                  {drawerRecords.map((item) => (
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
                      <span className={styles.durationPill}>
                        {formatReadableDuration(item.durationSeconds)}
                      </span>
                    </li>
                  ))}
                </ul>
              )
            )}

            {drawer === 'titles' && (
              !myTitles || myTitles.catalog.length === 0 ? (
                <Empty
                  title={auth.authenticated ? '正在同步工作室称号图鉴…' : '登录后查看称号图鉴'}
                  description="同步完成后即可浏览工作室全部称号说明与达成条件"
                />
              ) : (
                <div className={styles.drawerTitlesList}>
                  <div className={styles.drawerSubBanner}>
                    <Sparkles size={13} />
                    <span>
                      {isTitleEligible
                        ? `当前生效 ${unlockedTitleCount} / ${totalTitleCount} · 历史点亮 ${everAchievedTitleCount} 项 · 佩戴后实时展示在周榜`
                        : `共 ${totalTitleCount} 项工作室称号 · 当前届别仅作图鉴浏览（大一至大三可解锁佩戴）`}
                    </span>
                  </div>

                  {/* 成就升阶规则说明卡（标准 5 进制：逢 5 进 1，星 → 月亮 → 太阳 → 皇冠） */}
                  <section className={styles.tierRulesCard} aria-label="称号成就升阶规则">
                    <button
                      type="button"
                      className={styles.tierRulesHead}
                      onClick={() => setTierRulesOpen((v) => !v)}
                      aria-expanded={tierRulesOpen}
                    >
                      <span className={styles.tierRulesTitle}>
                        <Info size={13} />
                        <span>成就升阶规则详情（逢 5 进 1）</span>
                      </span>
                      <span className={styles.tierRulesToggle}>
                        {tierRulesOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </span>
                    </button>
                    <div className={styles.tierLadderRow}>
                      <span className={styles.tierLadderChip}>第 1 次 · 解锁</span>
                      <span className={styles.tierLadderArrow}>→</span>
                      <span className={styles.tierLadderChip}>
                        <Star size={11} className={styles.tierRuleStar} fill="currentColor" />
                        1–4 星（2–5 次）
                      </span>
                      <span className={styles.tierLadderArrow}>→</span>
                      <span className={styles.tierLadderChip}>
                        <Moon size={11} className={styles.tierRuleMoon} fill="currentColor" />
                        1 月亮（6 次）
                      </span>
                      <span className={styles.tierLadderArrow}>→</span>
                      <span className={styles.tierLadderChip}>
                        <Sun size={11} className={styles.tierRuleSun} fill="currentColor" />
                        1 太阳（26 次）
                      </span>
                      <span className={styles.tierLadderArrow}>→</span>
                      <span className={styles.tierLadderChip}>
                        <Crown size={11} className={styles.tierRuleCrown} fill="currentColor" />
                        1 皇冠（126 次）
                      </span>
                    </div>
                    {tierRulesOpen && (
                      <ul className={styles.tierRulesList}>
                        <li>
                          <strong>进位方式（5 进制 · 逢 5 进 1）：</strong>
                          达成 1 次解锁基础成就，第 2 次升为 1 星；每累计 5 颗同级图标自动进位（5 ⭐ = 1 🌙 月亮，5 🌙 = 1 ☀️ 太阳，5 ☀️ = 1 👑 皇冠）。
                        </li>
                        <li>
                          <strong>适用范围：</strong>
                          24 项周期 / 连胜 / 连续天数 / 事件称号均支持无限累计升阶；仅「收集者」「收集之王」为一次性图鉴里程碑。
                        </li>
                        <li>
                          <strong>防刷去重口径：</strong>
                          周/月类按考核周或自然月去重（每周期最多 +1）；连续 3 天类按不重叠 3 天段累计；赌王/戒赌按独立 5 连胜/5 连败轮次累计；大保底按每次抽卡回执累计；贡献王按连续 3 次正式发版 PR 轮次累计。
                        </li>
                        <li>
                          <strong>强制状态称号：</strong>
                          「求求你戒赌吧」「想吃紫蛋了」「相思了」「快思了」「体力不支」触发时强制亮牌并附带当前阶位；解除条件后撤下亮牌，但历史累计次数与阶位永久保留在图鉴中，下次触发直接延续升阶。
                        </li>
                      </ul>
                    )}
                  </section>

                  {myTitles.catalog.map((item) => {
                    const isBusy = equippingId === item.id;
                    const unlockCount = item.unlockCount ?? (item.unlocked ? 1 : 0);
                    const stackable = item.stackable !== false;
                    const tier = computeTitleAchievementTier(unlockCount, stackable);
                    const hasHistory = unlockCount > 0;
                    const remainingToNextMajor =
                      stackable && tier.nextMajorTierCount !== null
                        ? Math.max(0, tier.nextMajorTierCount - unlockCount)
                        : null;
                    return (
                      <div
                        key={item.id}
                        className={`${styles.titleCard} ${
                          item.unlocked
                            ? styles.titleCardUnlocked
                            : hasHistory
                              ? styles.titleCardHistory
                              : ''
                        } ${item.equipped ? styles.titleCardEquipped : ''}`}
                      >
                        <div className={styles.titleCardTop}>
                          <TitleBadge
                            title={item}
                            size="sm"
                            dimmed={isTitleEligible && !item.unlocked}
                          />
                          <span className={styles.proposerTag}>提出：{item.proposer}</span>
                        </div>
                        <p className={styles.titleDesc}>{item.description}</p>
                        <div className={styles.titleTierBox}>
                          {!stackable ? (
                            <span className={styles.titleTierSummary}>
                              一次性里程碑{hasHistory ? ' · 已永久点亮' : ''}
                            </span>
                          ) : hasHistory ? (
                            <div className={styles.titleTierLine}>
                              {tier.points > 0 && (
                                <TitleTierIcons count={unlockCount} stackable mode="full" size={12} />
                              )}
                              <span className={styles.titleTierSummary}>
                                {tier.points > 0 ? `${formatTitleTierText(tier)} · ` : '基础解锁 · '}
                                累计 {unlockCount} 次
                                {remainingToNextMajor && tier.nextMajorTierLabel
                                  ? `（再达成 ${remainingToNextMajor} 次升 ${tier.nextMajorTierLabel}）`
                                  : ''}
                              </span>
                            </div>
                          ) : (
                            <span className={styles.titleTierRule}>
                              可升阶 · 尚未达成
                            </span>
                          )}
                          {item.stackRuleText && (
                            <span className={styles.titleTierRule}>{item.stackRuleText}</span>
                          )}
                        </div>
                        <div className={styles.titleCardFooter}>
                          <span className={styles.titleProgress}>
                            {item.progressText || (item.unlocked ? '已解锁' : '未解锁')}
                          </span>
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            {isTitleEligible && item.unlocked && item.hideable && (
                              <Button
                                variant="glass"
                                size="small"
                                loading={equippingId === `vis:${item.id}`}
                                disabled={equippingId !== null && equippingId !== `vis:${item.id}`}
                                onClick={async () => {
                                  if (equippingId !== null) return;
                                  setEquippingId(`vis:${item.id}`);
                                  try {
                                    await setTitleVisibility(item.id, !item.hidden);
                                  } finally {
                                    setEquippingId(null);
                                  }
                                }}
                              >
                                {item.hidden ? '开启展示' : '关闭展示'}
                              </Button>
                            )}
                            {!isTitleEligible ? (
                              <Tag tone="neutral">{item.forced ? '状态类' : '荣誉图鉴'}</Tag>
                            ) : item.hidden && item.unlocked ? (
                              <Tag tone="neutral">已关闭</Tag>
                            ) : item.forced ? (
                              <Tag tone={item.unlocked ? 'warning' : 'neutral'}>
                                {item.unlocked ? '自动亮牌中' : '状态预警'}
                              </Tag>
                            ) : item.equipped ? (
                              <Tag tone="success" icon={<Check size={12} />}>
                                佩戴中
                              </Tag>
                            ) : item.unlocked ? (
                              <Button
                                variant="filled"
                                size="small"
                                loading={isBusy}
                                disabled={equippingId !== null && !isBusy}
                                onClick={async () => {
                                  if (equippingId !== null) return;
                                  setEquippingId(item.id);
                                  try {
                                    await equipTitle(item.id);
                                  } finally {
                                    setEquippingId(null);
                                  }
                                }}
                              >
                                佩戴
                              </Button>
                            ) : (
                              <Tag tone="neutral">未解锁</Tag>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            )}

            {drawer === 'history' && (
              historyLoading && weeklyHistory.length === 0 ? (
                <Empty title="正在拉取历史周考核…" />
              ) : weeklyHistory.length === 0 ? (
                <Empty title="暂无历史周考核记录" description="产生有效打卡记录后将按周汇总展示" />
              ) : (
                <ul className={styles.historyList}>
                  {weeklyHistory.map((row) => {
                    const pct =
                      row.weeklyGoalSeconds > 0
                        ? Math.min(100, Math.round((row.totalDurationSeconds / row.weeklyGoalSeconds) * 100))
                        : 100;
                    return (
                      <li key={row.weekKey} className={styles.historyRow}>
                        <div className={styles.historyTop}>
                          <span className={styles.historyWeek}>{row.weekKey}</span>
                          <span
                            className={`${styles.statusPill} ${
                              row.assessmentComplete ? styles.statusPillDone : styles.statusPillPending
                            }`}
                          >
                            {row.assessmentComplete ? (
                              <>
                                <CheckCircle2 size={11} /> 达标
                              </>
                            ) : (
                              `${pct}%`
                            )}
                          </span>
                        </div>
                        <div className={styles.historyMeta}>
                          <strong>{formatReadableDuration(row.totalDurationSeconds)}</strong>
                          <span>
                            目标 {formatReadableDuration(row.weeklyGoalSeconds)} · {row.sessionsCount} 次打卡
                          </span>
                        </div>
                        <div className={styles.progressTrack} aria-hidden="true">
                          <div
                            className={`${styles.progressFill} ${
                              row.assessmentComplete ? styles.progressFillDone : ''
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
