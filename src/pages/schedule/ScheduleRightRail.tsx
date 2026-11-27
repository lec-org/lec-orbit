/**
 * 日程课表右侧联动双栏组件（对齐「左主画布 + 右上迷你月历 + 右下当日/待办/图层」黄金布局）：
 * - 上半卡：基于组件库官方 `<Calendar />` 实现迷你月历导航，点选任意日期即联动主画布与下方当日议程；
 * - 下半卡：通过 `<SegmentedControl />` 在「当日议程」「全部待办」「图层筛选」三个高价值面板间切换，
 *   支持课程/日程/订阅日历/任务同日混排、图层增删改刷新与底部回车速记待办。
 */
import { useMemo, useState, type CSSProperties, type FormEvent, type JSX } from 'react';
import {
  Button,
  Calendar,
  Checkbox,
  Input,
  SearchField,
  SegmentedControl,
  Tag,
} from '@lec-space/liquidglass';
import {
  BookOpen,
  CalendarPlus,
  ChevronDown,
  ChevronRight,
  FolderKanban,
  Globe,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import {
  DEFAULT_STUDIO_CALENDAR_ID,
  eventCoversDate,
  expandCoursesForDate,
  type CalendarCategory,
  type CalendarEvent,
  type CalendarSubscription,
  type CalendarSubscriptionItem,
  type CalendarTask,
} from '@shared/calendar';
import {
  getWeekdayName,
  parseLocalDate,
  type ScheduleCourseWithMeetings,
  type ScheduleDetail,
} from '@shared/schedule';
import styles from './Schedule.module.css';

export type RightRailTab = 'agenda' | 'tasks' | 'layers';

export interface ScheduleRightRailProps {
  /** 当前选中日期（YYYY-MM-DD） */
  selectedDate: string;
  /** 今日日期（YYYY-MM-DD） */
  todayStr: string;
  /** 当前焦点日期对应的教学周（若处于学期范围内） */
  focusTeachWeek: number | null;
  /** 当前激活课表详情 */
  activeDetail: ScheduleDetail | null;
  /** 自定义日历分类列表 */
  categories: CalendarCategory[];
  /** 全部本地日程 */
  events: CalendarEvent[];
  /** 全部本地待办任务 */
  tasks: CalendarTask[];
  /** 订阅日历列表（含默认中国法定节假日与调休） */
  subscriptions: CalendarSubscription[];
  /** 订阅日历缓存事件列表 */
  subscriptionItems: CalendarSubscriptionItem[];
  /** 正在网络刷新的订阅 ID */
  syncingSubscriptionIds: string[];
  /** 工作室共享日程是否正在网络同步 */
  studioSyncing?: boolean;
  /** 当日是否法定放假/调休集合（用于课表展开跳过） */
  holidayOffDateSet: ReadonlySet<string>;
  /** 搜索关键词（同时过滤主画布） */
  searchQuery: string;
  /** 图层显隐开关 */
  showCoursesLayer: boolean;
  showTasksLayer: boolean;
  /** 回调 */
  onSelectDate: (dateStr: string) => void;
  onSearchChange: (q: string) => void;
  onToggleCategory: (categoryId: string, visible: boolean) => void;
  onEditCategory: (category: CalendarCategory) => void;
  onDeleteCategory: (category: CalendarCategory) => void;
  onCreateEventInCategory: (categoryId: string) => void;
  onRefreshStudioEvents?: () => void;
  onToggleSubscription: (subscriptionId: string, visible: boolean) => void;
  onRefreshSubscription: (subscriptionId: string) => void;
  onEditSubscription: (subscription: CalendarSubscription) => void;
  onDeleteSubscription: (subscription: CalendarSubscription) => void;
  onToggleCoursesLayer: (visible: boolean) => void;
  onToggleTasksLayer: (visible: boolean) => void;
  onQuickAddTask: (title: string, dueDate: string | null) => Promise<void>;
  onToggleTask: (taskId: string, completed: boolean) => Promise<void>;
  onDeleteTask: (taskId: string) => Promise<void>;
  onEditTask: (task: CalendarTask) => void;
  onEditEvent: (ev: CalendarEvent) => void;
  onEditCourse: (course: ScheduleCourseWithMeetings) => void;
  onCreateEventForDate: (dateStr: string) => void;
  onOpenAddCategory: () => void;
  onOpenManageSchedules: () => void;
}

type AgendaEntry =
  | {
      kind: 'course';
      key: string;
      sortTime: string;
      title: string;
      timeRange: string;
      meta: string;
      color: string;
      course: ScheduleCourseWithMeetings;
    }
  | {
      kind: 'event';
      key: string;
      sortTime: string;
      title: string;
      timeRange: string;
      meta: string;
      color: string;
      allDay: boolean;
      event: CalendarEvent;
    }
  | {
      kind: 'subscription';
      key: string;
      sortTime: string;
      title: string;
      timeRange: string;
      meta: string;
      color: string;
      allDay: boolean;
      subscription: CalendarSubscription;
    };

export function ScheduleRightRail({
  selectedDate,
  todayStr,
  focusTeachWeek,
  activeDetail,
  categories,
  events,
  tasks,
  subscriptions,
  subscriptionItems,
  syncingSubscriptionIds,
  studioSyncing = false,
  holidayOffDateSet,
  searchQuery,
  showCoursesLayer,
  showTasksLayer,
  onSelectDate,
  onSearchChange,
  onToggleCategory,
  onEditCategory,
  onDeleteCategory,
  onCreateEventInCategory,
  onRefreshStudioEvents,
  onToggleSubscription,
  onRefreshSubscription,
  onEditSubscription,
  onDeleteSubscription,
  onToggleCoursesLayer,
  onToggleTasksLayer,
  onQuickAddTask,
  onToggleTask,
  onDeleteTask,
  onEditTask,
  onEditEvent,
  onEditCourse,
  onCreateEventForDate,
  onOpenAddCategory,
  onOpenManageSchedules,
}: ScheduleRightRailProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<RightRailTab>('agenda');
  const [quickTitle, setQuickTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);

  const visibleCatIds = useMemo(
    () => new Set(categories.filter((c) => c.visible).map((c) => c.id)),
    [categories],
  );
  const categoryColorMap = useMemo(
    () => new Map(categories.map((c) => [c.id, c.color])),
    [categories],
  );
  const subscriptionById = useMemo(
    () => new Map(subscriptions.map((s) => [s.id, s])),
    [subscriptions],
  );
  const syncingSet = useMemo(() => new Set(syncingSubscriptionIds), [syncingSubscriptionIds]);

  // 选中日期的可读标题（如「11月27日 · 周五」）
  const selectedDayMeta = useMemo(() => {
    const parsed = parseLocalDate(selectedDate);
    if (Number.isNaN(parsed.getTime())) {
      return { label: selectedDate, weekday: '', isToday: false };
    }
    const isoDay = parsed.getDay() === 0 ? 7 : parsed.getDay();
    return {
      label: `${parsed.getMonth() + 1}月${parsed.getDate()}日`,
      weekday: getWeekdayName(isoDay),
      isToday: selectedDate === todayStr,
    };
  }, [selectedDate, todayStr]);

  // 选中日法定/手动状态角标
  const selectedDayHolidayBadge = useMemo<'off' | 'work' | null>(() => {
    for (const item of subscriptionItems) {
      const sub = subscriptionById.get(item.subscriptionId);
      if (!sub || !sub.visible) continue;
      if (item.startDate <= selectedDate && selectedDate <= item.endDate && item.badge) {
        return item.badge;
      }
    }
    if (activeDetail?.schedule.holidays.includes(selectedDate)) return 'off';
    return null;
  }, [subscriptionItems, subscriptionById, selectedDate, activeDetail]);

  // 当日议程（订阅日历 + 课程 + 本地日程按时间统一混排，全天事件置顶）
  const agendaEntries = useMemo<AgendaEntry[]>(() => {
    const list: AgendaEntry[] = [];

    for (const item of subscriptionItems) {
      const sub = subscriptionById.get(item.subscriptionId);
      if (!sub || !sub.visible) continue;
      if (!eventCoversDate(item, selectedDate)) continue;
      const color = item.badge === 'work' ? '#EF4444' : sub.color;
      list.push({
        kind: 'subscription',
        key: `sub:${item.id}`,
        sortTime: item.allDay ? '00:00' : item.startTime,
        title: item.title,
        timeRange: item.allDay ? '全天' : `${item.startTime}–${item.endTime}`,
        meta: item.location ? `${sub.name} · ${item.location}` : sub.name,
        color,
        allDay: item.allDay,
        subscription: sub,
      });
    }

    if (showCoursesLayer && activeDetail) {
      const occs = expandCoursesForDate(activeDetail, selectedDate, holidayOffDateSet);
      for (const occ of occs) {
        const metaParts = [
          occ.meeting.location,
          `第 ${occ.meeting.startSection}-${occ.meeting.endSection} 节`,
        ].filter(Boolean);
        list.push({
          kind: 'course',
          key: `crs:${occ.course.id}:${occ.meeting.id}`,
          sortTime: occ.startTime,
          title: occ.course.name,
          timeRange: `${occ.startTime}–${occ.endTime}`,
          meta: metaParts.join(' · '),
          color: occ.course.color,
          course: occ.course,
        });
      }
    }

    for (const ev of events) {
      if (!visibleCatIds.has(ev.calendarId)) continue;
      if (!eventCoversDate(ev, selectedDate)) continue;
      const metaParts = [
        ev.source === 'studio' ? `团队 · ${ev.creatorName || '工作室'}` : '',
        ev.location || '',
      ].filter(Boolean);
      list.push({
        kind: 'event',
        key: `evt:${ev.id}`,
        sortTime: ev.allDay ? '00:00' : ev.startTime,
        title: ev.title,
        timeRange: ev.allDay ? '全天' : `${ev.startTime}–${ev.endTime}`,
        meta: metaParts.join(' · '),
        color: categoryColorMap.get(ev.calendarId) ?? '#2563EB',
        allDay: ev.allDay,
        event: ev,
      });
    }

    return list.sort((a, b) => {
      const aAllDay = a.kind !== 'course' && a.allDay ? 0 : 1;
      const bAllDay = b.kind !== 'course' && b.allDay ? 0 : 1;
      if (aAllDay !== bAllDay) return aAllDay - bAllDay;
      return a.sortTime.localeCompare(b.sortTime);
    });
  }, [
    subscriptionItems,
    subscriptionById,
    selectedDate,
    showCoursesLayer,
    activeDetail,
    holidayOffDateSet,
    events,
    visibleCatIds,
    categoryColorMap,
  ]);

  // 选中当日的截止待办
  const selectedDayTasks = useMemo(
    () =>
      tasks
        .filter((t) => t.dueDate === selectedDate)
        .sort((a, b) => {
          if (a.completed !== b.completed) return a.completed ? 1 : -1;
          return (a.dueTime ?? '99:99').localeCompare(b.dueTime ?? '99:99');
        }),
    [tasks, selectedDate],
  );

  // 全部待办分组统计
  const taskGroups = useMemo(() => {
    const overdueOrToday: CalendarTask[] = [];
    const upcoming: CalendarTask[] = [];
    const inbox: CalendarTask[] = [];
    const completed: CalendarTask[] = [];

    for (const t of tasks) {
      if (t.completed) {
        completed.push(t);
      } else if (!t.dueDate) {
        inbox.push(t);
      } else if (t.dueDate <= todayStr) {
        overdueOrToday.push(t);
      } else {
        upcoming.push(t);
      }
    }
    overdueOrToday.sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));
    upcoming.sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));
    return {
      overdueOrToday,
      upcoming,
      inbox,
      completed,
      openCount: overdueOrToday.length + upcoming.length + inbox.length,
    };
  }, [tasks, todayStr]);

  const handleQuickSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const title = quickTitle.trim();
    if (!title || submitting) return;
    setSubmitting(true);
    try {
      await onQuickAddTask(title, activeTab === 'agenda' ? selectedDate : null);
      setQuickTitle('');
    } finally {
      setSubmitting(false);
    }
  };

  const renderTaskRow = (task: CalendarTask, showDateBadge = false) => {
    const isOverdue = Boolean(!task.completed && task.dueDate && task.dueDate < todayStr);
    return (
      <div
        key={task.id}
        className={`${styles.railTaskRow} ${task.completed ? styles.railTaskDone : ''}`}
        onClick={() => onEditTask(task)}
      >
        <span onClick={(e) => e.stopPropagation()} className={styles.railTaskCheck}>
          <Checkbox
            checked={task.completed}
            onCheckedChange={(checked) => void onToggleTask(task.id, checked)}
          />
        </span>
        <div className={styles.railTaskMain}>
          <span className={styles.railTaskTitle}>{task.title}</span>
          {(showDateBadge || task.dueTime || task.priority === 'high') && (
            <div className={styles.railTaskSub}>
              {showDateBadge && task.dueDate && (
                <span className={isOverdue ? styles.railOverdueText : undefined}>
                  {task.dueDate.slice(5)}
                  {task.dueTime ? ` ${task.dueTime}` : ''}
                </span>
              )}
              {!showDateBadge && task.dueTime && <span>{task.dueTime} 截止</span>}
              {task.priority === 'high' && !task.completed && (
                <span className={styles.railPriorityHigh}>高优</span>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          className={styles.railRowDelete}
          aria-label="删除待办"
          onClick={(e) => {
            e.stopPropagation();
            void onDeleteTask(task.id);
          }}
        >
          <Trash2 size={12} />
        </button>
      </div>
    );
  };

  return (
    <aside className={styles.rightRail} aria-label="迷你月历与当日联动面板">
      {/* 右上卡片：迷你月历（复用官方 Calendar 组件） */}
      <section className={styles.railCard}>
        <div className={styles.railMiniTop}>
          <div className={styles.railMiniMeta}>
            {focusTeachWeek != null ? (
              <Tag tone="info">第 {focusTeachWeek} 周</Tag>
            ) : (
              <span className={styles.railCardCaption}>月历定位</span>
            )}
            {activeDetail && (
              <span className={styles.railMiniTerm} title={activeDetail.schedule.name}>
                {activeDetail.schedule.name}
              </span>
            )}
          </div>
        </div>

        <div className={styles.railMiniCalendarWrap}>
          <Calendar
            key={selectedDate.slice(0, 7)}
            variant="plain"
            value={selectedDate}
            today={todayStr}
            onValueChange={(next) => {
              if (next) onSelectDate(next);
            }}
          />
        </div>
      </section>

      {/* 右下卡片：当日议程 / 全部待办 / 图层筛选 */}
      <section className={`${styles.railCard} ${styles.railPanelCard}`}>
        <div className={styles.railTabsWrap}>
          <SegmentedControl
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as RightRailTab)}
            items={[
              { value: 'agenda', label: '当日' },
              {
                value: 'tasks',
                label: taskGroups.openCount > 0 ? `待办 ${taskGroups.openCount}` : '待办',
              },
              { value: 'layers', label: '日历' },
            ]}
          />
        </div>

        {/* Tab 1：当日议程（订阅日历 + 课程 + 日程 + 当日待办） */}
        {activeTab === 'agenda' && (
          <>
            <div className={styles.railAgendaHead}>
              <div className={styles.railAgendaDate}>
                <strong>{selectedDayMeta.label}</strong>
                <span>{selectedDayMeta.weekday}</span>
                {selectedDayMeta.isToday && <Tag tone="info">今天</Tag>}
                {selectedDayHolidayBadge === 'off' && <Tag tone="warning">休</Tag>}
                {selectedDayHolidayBadge === 'work' && <Tag tone="danger">班</Tag>}
              </div>
              <button
                type="button"
                className={styles.railIconAction}
                title="在选中日新建日程"
                aria-label="在选中日新建日程"
                onClick={() => onCreateEventForDate(selectedDate)}
              >
                <CalendarPlus size={14} />
              </button>
            </div>

            <div className={styles.railScrollBody}>
              {agendaEntries.length === 0 && selectedDayTasks.length === 0 ? (
                <div className={styles.railEmptyHint}>
                  <span>{selectedDayMeta.isToday ? '今天暂无排课或日程' : '当日暂无安排'}</span>
                  <button
                    type="button"
                    className={styles.railEmptyBtn}
                    onClick={() => onCreateEventForDate(selectedDate)}
                  >
                    + 添加一条日程
                  </button>
                </div>
              ) : (
                <>
                  {agendaEntries.map((entry) => (
                    <button
                      key={entry.key}
                      type="button"
                      className={`${styles.railAgendaItem} ${
                        entry.kind === 'course' ? styles.railAgendaCourse : styles.railAgendaEvent
                      }`}
                      style={{ '--rail-accent': entry.color } as CSSProperties}
                      onClick={() => {
                        if (entry.kind === 'course') {
                          onEditCourse(entry.course);
                        } else if (entry.kind === 'event') {
                          onEditEvent(entry.event);
                        } else {
                          onEditSubscription(entry.subscription);
                        }
                      }}
                    >
                      <span className={styles.railAgendaBar} aria-hidden />
                      <div className={styles.railAgendaContent}>
                        <div className={styles.railAgendaTopRow}>
                          <span className={styles.railAgendaTitle}>{entry.title}</span>
                          <span className={styles.railAgendaTime}>{entry.timeRange}</span>
                        </div>
                        {entry.meta && (
                          <div className={styles.railAgendaMeta}>
                            {entry.kind === 'course' ? (
                              <BookOpen size={11} />
                            ) : entry.kind === 'subscription' ? (
                              <Globe size={11} />
                            ) : (
                              <MapPin size={11} />
                            )}
                            <span>{entry.meta}</span>
                          </div>
                        )}
                      </div>
                    </button>
                  ))}

                  {selectedDayTasks.length > 0 && (
                    <div className={styles.railSubSection}>
                      <div className={styles.railSubTitle}>
                        当日待办（{selectedDayTasks.filter((t) => !t.completed).length}/
                        {selectedDayTasks.length}）
                      </div>
                      {selectedDayTasks.map((t) => renderTaskRow(t, false))}
                    </div>
                  )}
                </>
              )}
            </div>

            <form className={styles.railQuickForm} onSubmit={(e) => void handleQuickSubmit(e)}>
              <Input
                value={quickTitle}
                onValueChange={setQuickTitle}
                placeholder={`添加 ${selectedDayMeta.label} 待办，回车创建`}
              />
              <Button
                type="submit"
                variant="filled"
                size="small"
                icon={<Plus size={14} />}
                disabled={!quickTitle.trim() || submitting}
                aria-label="添加当日待办"
              />
            </form>
          </>
        )}

        {/* Tab 2：全部待办（今日/逾期 + 后续 + 收集箱 + 已完成） */}
        {activeTab === 'tasks' && (
          <>
            <div className={styles.railScrollBody}>
              {taskGroups.openCount === 0 && taskGroups.completed.length === 0 ? (
                <div className={styles.railEmptyHint}>
                  <span>暂无待办任务，在下方输入即可快速记一条</span>
                </div>
              ) : (
                <>
                  {taskGroups.overdueOrToday.length > 0 && (
                    <div className={styles.railSubSection}>
                      <div className={styles.railSubTitle}>
                        今日与逾期（{taskGroups.overdueOrToday.length}）
                      </div>
                      {taskGroups.overdueOrToday.map((t) => renderTaskRow(t, true))}
                    </div>
                  )}

                  {taskGroups.upcoming.length > 0 && (
                    <div className={styles.railSubSection}>
                      <div className={styles.railSubTitle}>
                        即将到来（{taskGroups.upcoming.length}）
                      </div>
                      {taskGroups.upcoming.map((t) => renderTaskRow(t, true))}
                    </div>
                  )}

                  {taskGroups.inbox.length > 0 && (
                    <div className={styles.railSubSection}>
                      <div className={styles.railSubTitle}>
                        无日期收集箱（{taskGroups.inbox.length}）
                      </div>
                      {taskGroups.inbox.map((t) => renderTaskRow(t, false))}
                    </div>
                  )}

                  {taskGroups.completed.length > 0 && (
                    <div className={styles.railSubSection}>
                      <button
                        type="button"
                        className={styles.railCollapseBtn}
                        onClick={() => setShowCompleted((v) => !v)}
                      >
                        {showCompleted ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        <span>已完成（{taskGroups.completed.length}）</span>
                      </button>
                      {showCompleted && taskGroups.completed.map((t) => renderTaskRow(t, true))}
                    </div>
                  )}
                </>
              )}
            </div>

            <form className={styles.railQuickForm} onSubmit={(e) => void handleQuickSubmit(e)}>
              <Input
                value={quickTitle}
                onValueChange={setQuickTitle}
                placeholder="快速记一条待办到收集箱，回车创建"
              />
              <Button
                type="submit"
                variant="filled"
                size="small"
                icon={<Plus size={14} />}
                disabled={!quickTitle.trim() || submitting}
                aria-label="添加待办"
              />
            </form>
          </>
        )}

        {/* Tab 3：搜索与日历图层管理（支持编辑、删除、快速新建日程、刷新订阅） */}
        {activeTab === 'layers' && (
          <>
            <div className={styles.railSearchWrap}>
              <SearchField
                value={searchQuery}
                onValueChange={onSearchChange}
                placeholder="筛选课程、日程或待办..."
              />
            </div>

            <div className={styles.railScrollBody}>
              <div className={styles.railSubSection}>
                <div className={styles.railSubTitle}>我的日历</div>
                {categories.map((cat) => {
                  const isStudioCal = cat.id === DEFAULT_STUDIO_CALENDAR_ID;
                  return (
                    <div key={cat.id} className={styles.railLayerRow}>
                      <label className={styles.railLayerLabel}>
                        <Checkbox
                          checked={cat.visible}
                          onCheckedChange={(checked) => onToggleCategory(cat.id, checked)}
                        />
                        <span className={styles.colorDot} style={{ backgroundColor: cat.color }} />
                        <span className={styles.railLayerName}>{cat.name}</span>
                        {isStudioCal && <span className={styles.railTeamPill}>共享</span>}
                      </label>
                      <div className={styles.railLayerActions}>
                        {isStudioCal && onRefreshStudioEvents && (
                          <button
                            type="button"
                            className={styles.railLayerBtn}
                            title="同步工作室共享日程"
                            aria-label="同步工作室共享日程"
                            disabled={studioSyncing}
                            onClick={onRefreshStudioEvents}
                          >
                            <RefreshCw
                              size={11}
                              className={studioSyncing ? styles.spinIcon : undefined}
                            />
                          </button>
                        )}
                        <button
                          type="button"
                          className={styles.railLayerBtn}
                          title={`在「${cat.name}」下新建日程`}
                          aria-label={`在${cat.name}下新建日程`}
                          onClick={() => onCreateEventInCategory(cat.id)}
                        >
                          <Plus size={12} />
                        </button>
                        <button
                          type="button"
                          className={styles.railLayerBtn}
                          title="编辑名称与配色"
                          aria-label={`编辑${cat.name}`}
                          onClick={() => onEditCategory(cat)}
                        >
                          <Pencil size={11} />
                        </button>
                        {!cat.isBuiltin && (
                          <button
                            type="button"
                            className={`${styles.railLayerBtn} ${styles.railLayerBtnDanger}`}
                            title="删除该日历分组"
                            aria-label={`删除${cat.name}`}
                            onClick={() => onDeleteCategory(cat)}
                          >
                            <Trash2 size={11} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}

                <div className={styles.railLayerRow}>
                  <label className={styles.railLayerLabel}>
                    <Checkbox
                      checked={showTasksLayer}
                      onCheckedChange={(checked) => onToggleTasksLayer(checked)}
                    />
                    <span className={styles.colorDot} style={{ backgroundColor: '#10B981' }} />
                    <span className={styles.railLayerName}>
                      我的任务（{taskGroups.openCount}）
                    </span>
                  </label>
                </div>
              </div>

              <div className={styles.railSubSection}>
                <div className={styles.railSubTitle}>订阅日历</div>
                {subscriptions.map((sub) => {
                  const isSyncing = syncingSet.has(sub.id);
                  return (
                    <div key={sub.id} className={styles.railLayerRow}>
                      <label className={styles.railLayerLabel} title={sub.lastError || sub.url}>
                        <Checkbox
                          checked={sub.visible}
                          onCheckedChange={(checked) => onToggleSubscription(sub.id, checked)}
                        />
                        <span className={styles.colorDot} style={{ backgroundColor: sub.color }} />
                        <span className={styles.railLayerName}>{sub.name}</span>
                      </label>
                      <div className={styles.railLayerActions}>
                        <button
                          type="button"
                          className={styles.railLayerBtn}
                          title="立即刷新同步"
                          aria-label={`刷新${sub.name}`}
                          disabled={isSyncing}
                          onClick={() => onRefreshSubscription(sub.id)}
                        >
                          <RefreshCw
                            size={11}
                            className={isSyncing ? styles.spinIcon : undefined}
                          />
                        </button>
                        <button
                          type="button"
                          className={styles.railLayerBtn}
                          title="管理订阅日历"
                          aria-label={`管理${sub.name}`}
                          onClick={() => onEditSubscription(sub)}
                        >
                          <Pencil size={11} />
                        </button>
                        {!sub.isBuiltin && (
                          <button
                            type="button"
                            className={`${styles.railLayerBtn} ${styles.railLayerBtnDanger}`}
                            title="退订并删除"
                            aria-label={`退订${sub.name}`}
                            onClick={() => onDeleteSubscription(sub)}
                          >
                            <Trash2 size={11} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {activeDetail && (
                <div className={styles.railSubSection}>
                  <div className={styles.railSubTitle}>课程表</div>
                  <div className={styles.railLayerRow}>
                    <label className={styles.railLayerLabel}>
                      <Checkbox
                        checked={showCoursesLayer}
                        onCheckedChange={(checked) => onToggleCoursesLayer(checked)}
                      />
                      <span className={styles.colorDot} style={{ backgroundColor: '#6366F1' }} />
                      <span className={styles.railLayerName}>{activeDetail.schedule.name}</span>
                    </label>
                  </div>
                </div>
              )}
            </div>

            <div className={styles.railLayerFooter}>
              <Button
                variant="glass"
                size="small"
                icon={<Plus size={13} />}
                onClick={onOpenAddCategory}
              >
                添加日历
              </Button>
              <Button
                variant="glass"
                size="small"
                icon={<FolderKanban size={13} />}
                onClick={onOpenManageSchedules}
              >
                管理课表
              </Button>
            </div>
          </>
        )}
      </section>
    </aside>
  );
}
