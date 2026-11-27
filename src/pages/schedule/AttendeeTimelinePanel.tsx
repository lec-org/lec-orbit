/**
 * 仿飞书「创建/编辑日程」右侧多人忙闲时间轴面板（AttendeeTimelinePanel）：
 * - 顶部日期切换与左栏表单双向联动；
 * - 粘性成员头像列头（支持横向滚动、年级徽标、冲突状态高亮与当日全天胶囊）；
 * - 24 小时时间轴 + 红色当前时间线 + 横跨全员的选中时段高亮带（支持点击空白格快速移位）；
 * - 每人列内复用 LiquidGlass 升级后的 `layoutDayTimedEvents`（空列扩张 + 高并发阶梯避让），
 *   工作室内公开展示课表课程、个人日程与工作室日程（含未回复虚线框 / 已谢绝删除线）。
 */
import { useEffect, useMemo, useRef, type CSSProperties, type JSX } from 'react';
import { Avatar, Button } from '@lec-space/liquidglass';
import { layoutDayTimedEvents } from '@shared/overlapLayout';
import {
  AlertCircle,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  EyeOff,
  RefreshCw,
} from 'lucide-react';
import {
  formatMinutesToHm,
  hasConflictInRange,
  parseHmToMinutes,
} from '@shared/freeBusy';
import { formatLocalDate, getWeekdayName, parseLocalDate } from '@shared/schedule';
import type {
  MemberFreeBusyTimelineDTO,
} from '@/services/orbitServerApi';
import styles from './Schedule.module.css';

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const HOUR_HEIGHT = 48;
const CANVAS_HEIGHT = HOURS.length * HOUR_HEIGHT;

export { findCommonFreeSlots, formatMinutesToHm, hasConflictInRange, parseHmToMinutes } from '@shared/freeBusy';

export interface AttendeeTimelinePanelProps {
  date: string;
  onDateChange: (date: string) => void;
  allDay: boolean;
  startTime: string;
  endTime: string;
  onSelectTimeRange: (startTime: string, endTime: string) => void;
  members: MemberFreeBusyTimelineDTO[];
  loading: boolean;
  fallbackNotice?: string | null;
  onRefresh: () => void;
  onHideMember?: (userId: string) => void;
}

export function AttendeeTimelinePanel({
  date,
  onDateChange,
  allDay,
  startTime,
  endTime,
  onSelectTimeRange,
  members,
  loading,
  fallbackNotice,
  onRefresh,
  onHideMember,
}: AttendeeTimelinePanelProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const todayStr = formatLocalDate(new Date());
  const isToday = date === todayStr;

  const nowDate = new Date();
  const nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();

  const selectedStartMin = parseHmToMinutes(startTime);
  const selectedEndMin = Math.max(selectedStartMin + 15, parseHmToMinutes(endTime));
  const durationMin = Math.max(30, selectedEndMin - selectedStartMin);

  // 打开面板、切换日期或异步成员列表首次加载完成后，自动滚到选中时间带前 1.5 小时（默认 08:00 附近）
  const hasMembers = members.length > 0;
  useEffect(() => {
    if (!hasMembers) return;
    const el = scrollRef.current;
    if (!el) return;
    const anchorMin = allDay ? 8 * 60 : Math.max(0, selectedStartMin - 90);
    el.scrollTop = (anchorMin / 60) * HOUR_HEIGHT;
  }, [date, allDay, hasMembers]);

  const dateLabel = useMemo(() => {
    const d = parseLocalDate(date);
    if (Number.isNaN(d.getTime())) return date;
    const iso = d.getDay() === 0 ? 7 : d.getDay();
    const suffix = isToday ? ' 今天' : ` ${getWeekdayName(iso)}`;
    return `${d.getMonth() + 1}月${d.getDate()}日${suffix}`;
  }, [date, isToday]);

  const stepDay = (delta: number) => {
    const d = parseLocalDate(date);
    if (Number.isNaN(d.getTime())) return;
    d.setDate(d.getDate() + delta);
    onDateChange(formatLocalDate(d));
  };

  // 点击时间轴某小时格，快速将选中时段移动到该时间（保留原时长）
  const handleSlotClick = (hour: number, halfOffset: number) => {
    const nextStart = Math.min(24 * 60 - 30, hour * 60 + halfOffset);
    const nextEnd = Math.min(24 * 60 - 1, nextStart + durationMin);
    onSelectTimeRange(formatMinutesToHm(nextStart), formatMinutesToHm(nextEnd));
  };

  const colTemplate = useMemo(
    () => `54px repeat(${Math.max(1, members.length)}, minmax(112px, 1fr))`,
    [members.length],
  );

  return (
    <div className={styles.fbPanel}>
      {/* 顶部日期切换栏 */}
      <div className={styles.fbToolbar}>
        <div className={styles.fbToolbarLeft}>
          <Button
            size="small"
            variant="glass"
            onClick={() => onDateChange(todayStr)}
            disabled={isToday}
          >
            今天
          </Button>
          <div className={styles.fbStepGroup}>
            <button
              type="button"
              className={styles.fbIconBtn}
              aria-label="前一天"
              onClick={() => stepDay(-1)}
            >
              <ChevronLeft size={14} />
            </button>
            <button
              type="button"
              className={styles.fbIconBtn}
              aria-label="后一天"
              onClick={() => stepDay(1)}
            >
              <ChevronRight size={14} />
            </button>
          </div>
          <strong className={styles.fbDateHeading}>{dateLabel}</strong>
        </div>

        <div className={styles.fbToolbarRight}>
          <span className={styles.fbLegend}>
            <span className={styles.fbLegendDot} style={{ background: '#6366F1' }} />
            课表
            <span className={styles.fbLegendDot} style={{ background: '#7C3AED' }} />
            工作室
            <span className={styles.fbLegendDot} style={{ background: '#2563EB' }} />
            个人
          </span>
          <button
            type="button"
            className={styles.fbIconBtn}
            title="刷新成员忙闲时间"
            aria-label="刷新成员忙闲时间"
            disabled={loading}
            onClick={onRefresh}
          >
            <RefreshCw size={13} className={loading ? styles.spinIcon : undefined} />
          </button>
        </div>
      </div>

      {fallbackNotice && (
        <div className={styles.fbNoticeBar}>
          <AlertCircle size={13} />
          <span>{fallbackNotice}</span>
        </div>
      )}

      {members.length === 0 ? (
        <div className={styles.fbEmpty}>
          <CalendarClock size={26} />
          <strong>暂无可显示的参与人时间轴</strong>
          <span>在左侧按年级批量添加或单独搜索成员，即可实时对比大家的空余时间。</span>
        </div>
      ) : (
        <div ref={scrollRef} className={styles.fbScrollArea}>
          <div
            className={styles.fbGridContainer}
            style={{ minWidth: `${54 + members.length * 114}px` }}
          >
            {/* 粘性成员头像列头 */}
            <div className={styles.fbHeaderRow} style={{ gridTemplateColumns: colTemplate }}>
              <div className={styles.fbGutterHead}>GMT+8</div>
              {members.map((m) => {
                const isConflict = hasConflictInRange(
                  m.blocks,
                  selectedStartMin,
                  selectedEndMin,
                  allDay,
                );
                const allDayBlocks = m.blocks.filter((b) => b.allDay);
                return (
                  <div
                    key={m.userId}
                    className={`${styles.fbMemberHead} ${isConflict ? styles.fbMemberHeadConflict : ''}`}
                  >
                    <div className={styles.fbAvatarWrap}>
                      <Avatar
                        size={34}
                        src={m.avatar || undefined}
                        name={m.displayName || m.username}
                      />
                      {isConflict && (
                        <span
                          className={styles.fbConflictBadge}
                          title="该成员在当前所选时段存在日程或课程冲突"
                        >
                          忙
                        </span>
                      )}
                      {onHideMember && members.length > 1 && (
                        <button
                          type="button"
                          className={styles.fbHideColBtn}
                          title="暂时在右侧时间轴隐藏此人"
                          onClick={() => onHideMember(m.userId)}
                        >
                          <EyeOff size={11} />
                        </button>
                      )}
                    </div>
                    <span className={styles.fbMemberName} title={m.displayName}>
                      {m.displayName}
                    </span>
                    <span className={styles.fbMemberSub}>
                      {m.enrollYear ? `${m.enrollYear}级` : m.isCaptain ? '队长' : '成员'}
                      {!m.hasScheduleSynced ? ' · 未同步课表' : ''}
                    </span>

                    {allDayBlocks.length > 0 && (
                      <div className={styles.fbHeadAllDayList}>
                        {allDayBlocks.slice(0, 2).map((b) => (
                          <span
                            key={b.id}
                            className={styles.fbHeadAllDayPill}
                            style={{ '--fb-color': b.color } as CSSProperties}
                            title={`${b.title}（全天）`}
                          >
                            {b.title}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 24 小时多人并行时间画布 */}
            <div
              className={styles.fbBodyGrid}
              style={{
                gridTemplateColumns: colTemplate,
                height: CANVAS_HEIGHT,
              }}
            >
              {/* 左侧时间刻度 */}
              <div className={styles.fbTimeGutter}>
                {HOURS.map((h) => (
                  <div
                    key={h}
                    className={styles.fbHourLabel}
                    style={{ height: HOUR_HEIGHT }}
                  >
                    {h === 0 ? '' : `${String(h).padStart(2, '0')}:00`}
                  </div>
                ))}
                {isToday && (
                  <span
                    className={styles.fbNowTimeTag}
                    style={{ top: (nowMinutes / 60) * HOUR_HEIGHT }}
                  >
                    {formatMinutesToHm(nowMinutes)}
                  </span>
                )}
              </div>

              {/* 横跨全员的选中时间高亮带 */}
              {!allDay && (
                <div
                  className={styles.fbSelectionBand}
                  style={{
                    top: (selectedStartMin / 60) * HOUR_HEIGHT,
                    height: Math.max(18, ((selectedEndMin - selectedStartMin) / 60) * HOUR_HEIGHT),
                  }}
                  aria-hidden="true"
                >
                  <span className={styles.fbSelectionTag}>
                    {startTime} – {endTime}
                  </span>
                </div>
              )}

              {/* 红色当前时间横线 */}
              {isToday && (
                <div
                  className={styles.fbNowLine}
                  style={{ top: (nowMinutes / 60) * HOUR_HEIGHT }}
                  aria-hidden="true"
                />
              )}

              {/* 每名成员一列：内部复用升级后的重叠避让算法 */}
              {members.map((m) => {
                const timedBlocks = m.blocks.filter((b) => !b.allDay);
                const layoutMap = layoutDayTimedEvents(
                  timedBlocks.map((b) => {
                    const s = parseHmToMinutes(b.startTime);
                    const e = Math.max(s + 15, parseHmToMinutes(b.endTime));
                    return { id: b.id, startMinutes: s, endMinutes: e };
                  }),
                );

                return (
                  <div key={m.userId} className={styles.fbMemberCol}>
                    {HOURS.map((h) => (
                      <div
                        key={h}
                        className={styles.fbHourCell}
                        style={{ height: HOUR_HEIGHT }}
                      >
                        <button
                          type="button"
                          className={styles.fbHalfSlot}
                          title={`点击将日程移至 ${String(h).padStart(2, '0')}:00`}
                          onClick={() => handleSlotClick(h, 0)}
                        />
                        <button
                          type="button"
                          className={styles.fbHalfSlot}
                          title={`点击将日程移至 ${String(h).padStart(2, '0')}:30`}
                          onClick={() => handleSlotClick(h, 30)}
                        />
                      </div>
                    ))}

                    {timedBlocks.map((b) => {
                      const box = layoutMap.get(b.id);
                      if (!box) return null;
                      const isTentative = b.status === 'tentative';
                      const isDeclined = b.status === 'declined';
                      const duration =
                        parseHmToMinutes(b.endTime) - parseHmToMinutes(b.startTime);
                      const tooltip = [
                        b.title,
                        `${b.startTime}–${b.endTime}`,
                        b.location ? `@${b.location}` : '',
                        b.meta ?? '',
                      ]
                        .filter(Boolean)
                        .join(' · ');

                      return (
                        <div
                          key={b.id}
                          className={`${styles.fbEventBlock} ${isTentative ? styles.fbEventTentative : ''} ${isDeclined ? styles.fbEventDeclined : ''}`}
                          style={
                            {
                              '--fb-color': b.color,
                              top: `${box.topPercent}%`,
                              height: `${box.heightPercent}%`,
                              left: `calc(${box.leftPercent}% + 2px)`,
                              width: `calc(${box.widthPercent}% - 4px)`,
                              zIndex: box.zIndex,
                            } as CSSProperties
                          }
                          title={tooltip}
                        >
                          <span className={styles.fbEventTitle}>
                            {b.title}
                            {isTentative ? '（未回复）' : ''}
                          </span>
                          <span className={styles.fbEventTime}>
                            {b.startTime}–{b.endTime}
                          </span>
                          {b.location && duration >= 45 && (
                            <span className={styles.fbEventSub}>@{b.location}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
