/**
 * 课程表配套管理弹窗集合（完整对标 WakeUp 拆解清单）：
 * 1. CourseListDialog（已添课程汇总、批量编辑删除、清空当前课表、添加课程）
 * 2. TimetableEditorDialog（编辑时间表、固定上课时长 45 分钟联动、24 小时制、增删节次与西柚预设还原）
 * 3. ScheduleSettingsDialog（课表数据、开学日期、每周起始日、当前周联动、节假日、节数/周数、课前提醒）
 * 4. ScheduleListDialog（多课表新建、切换、删除管理）
 * 5. ShareScheduleDialog（导出标准 .ics 日历 + 一键复制 Orbit 分享文本）
 */
import { useEffect, useState, type JSX } from 'react';
import {
  Button,
  Checkbox,
  DatePicker,
  Dialog,
  Input,
  Message,
  SegmentedControl,
  Select,
  Stepper,
  Switch,
  Tag,
  TimeField,
} from '@lec-space/liquidglass';
import { Calendar, Check, Copy, Plus, RotateCcw, Trash2 } from 'lucide-react';
import {
  SWPU_CHENGDU_DEFAULT_SLOTS,
  addMinutesToTime,
  applyFixedDurationToSlot,
  computeStartDateFromWeek,
  computeWeekFromStartDate,
  getWeekdayName,
  type ScheduleCourseWithMeetings,
  type ScheduleDetail,
  type ScheduleSummary,
  type ScheduleTimetable,
  type TimetableSlot,
} from '@shared/schedule';
import { getOrbitClient } from '@/services/orbitClient';
import { notifyToast } from '@/services/orbitToast';
import styles from './Schedule.module.css';

// ── 1. 已添课程管理弹窗 ────────────────────────────────────────────────────

interface CourseListDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: ScheduleDetail;
  onSelectCourse: (course: ScheduleCourseWithMeetings) => void;
  onAddCourse: () => void;
  onDeleteCourses: (courseIds: string[]) => Promise<void>;
  onClearAll: () => Promise<void>;
}

export function CourseListDialog({
  open,
  onOpenChange,
  detail,
  onSelectCourse,
  onAddCourse,
  onDeleteCourses,
  onClearAll,
}: CourseListDialogProps): JSX.Element {
  const [editMode, setEditMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (!open) {
      setEditMode(false);
      setSelectedIds([]);
      setConfirmClear(false);
    }
  }, [open]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id],
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="regular"
      title={`已添课程 · 共 ${detail.courses.length} 门`}
      description={`当前课表「${detail.schedule.name}」，点击任意课程可查看或修改上课时间段。`}
    >
      <div className={styles.dialogContainer}>
        <div className={styles.dialogBody}>
        <div className={styles.inlineRow} style={{ justifyContent: 'space-between' }}>
          <Tag tone="neutral">
            共 {detail.courses.length} 门课程 · {detail.schedule.meetingCount} 条排课
          </Tag>
          <div className={styles.inlineRow}>
            {editMode && selectedIds.length > 0 && (
              <Button
                variant="filled"
                size="small"
                destructive
                icon={<Trash2 size={13} />}
                onClick={() => {
                  void onDeleteCourses(selectedIds).then(() => {
                    setSelectedIds([]);
                    setEditMode(false);
                    notifyToast({ tone: 'info', title: '已删除所选课程' });
                  });
                }}
              >
                删除所选 ({selectedIds.length})
              </Button>
            )}
            <Button
              variant="glass"
              size="small"
              onClick={() => {
                setEditMode((v) => !v);
                setSelectedIds([]);
              }}
            >
              {editMode ? '完成编辑' : '编辑'}
            </Button>
          </div>
        </div>

        <div className={styles.previewList} style={{ maxHeight: 340 }}>
          {detail.courses.map((course) => {
            const checked = selectedIds.includes(course.id);
            return (
              <div
                key={course.id}
                className={styles.courseDirItem}
                onClick={() => {
                  if (editMode) {
                    toggleSelect(course.id);
                  } else {
                    onOpenChange(false);
                    onSelectCourse(course);
                  }
                }}
              >
                <div className={styles.previewItemLeft}>
                  {editMode && (
                    <span onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={checked} onCheckedChange={() => toggleSelect(course.id)} />
                    </span>
                  )}
                  <span className={styles.colorDot} style={{ backgroundColor: course.color }} />
                  <div style={{ minWidth: 0 }}>
                    <div className={styles.previewItemTitle}>{course.name}</div>
                    <div className={styles.previewItemSub}>
                      {course.meetings
                        .map(
                          (m) =>
                            `${getWeekdayName(m.dayOfWeek)} ${m.startSection}-${m.endSection}节 ${m.location || ''}`,
                        )
                        .join(' · ')}
                    </div>
                  </div>
                </div>
                {course.credit != null && <Tag tone="neutral">{course.credit} 学分</Tag>}
              </div>
            );
          })}
          {detail.courses.length === 0 && (
            <Message tone="info">当前课表暂无课程，可点击下方「添加课程」或从西柚教务一键导入。</Message>
          )}
        </div>

        {confirmClear && (
          <Message tone="error">
            确定清空「{detail.schedule.name}」的全部课程吗？此操作无法撤销。
          </Message>
        )}
        </div>

        <div className={styles.dialogFooter}>
          {confirmClear ? (
            <div className={styles.inlineRow}>
              <Button
                variant="filled"
                destructive
                size="small"
                onClick={() => {
                  void onClearAll().then(() => {
                    setConfirmClear(false);
                    notifyToast({ tone: 'info', title: '已清空当前课表' });
                  });
                }}
              >
                确认清空
              </Button>
              <Button variant="glass" size="small" onClick={() => setConfirmClear(false)}>
                取消
              </Button>
            </div>
          ) : (
            <Button
              variant="glass"
              destructive
              disabled={detail.courses.length === 0}
              onClick={() => setConfirmClear(true)}
            >
              清空当前课表
            </Button>
          )}

          <div className={styles.dialogFooterRight}>
            <Button
              variant="filled"
              icon={<Plus size={14} />}
              onClick={() => {
                onOpenChange(false);
                onAddCourse();
              }}
            >
              添加课程
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// ── 2. 编辑时间表弹窗 ──────────────────────────────────────────────────────

interface TimetableEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  timetable: ScheduleTimetable;
  onSave: (input: {
    id: string;
    name: string;
    fixedDurationEnabled: boolean;
    defaultDurationMinutes: number;
    slots: TimetableSlot[];
  }) => Promise<void>;
}

export function TimetableEditorDialog({
  open,
  onOpenChange,
  timetable,
  onSave,
}: TimetableEditorDialogProps): JSX.Element {
  const [name, setName] = useState(timetable.name);
  const [fixedDurationEnabled, setFixedDurationEnabled] = useState(timetable.fixedDurationEnabled);
  const [defaultDurationMinutes, setDefaultDurationMinutes] = useState(
    timetable.defaultDurationMinutes,
  );
  const [slots, setSlots] = useState<TimetableSlot[]>(timetable.slots);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(timetable.name);
    setFixedDurationEnabled(timetable.fixedDurationEnabled);
    setDefaultDurationMinutes(timetable.defaultDurationMinutes);
    setSlots(timetable.slots.map((s) => ({ ...s })));
  }, [open, timetable]);

  const handleStartChange = (section: number, newStart: string) => {
    setSlots((prev) =>
      applyFixedDurationToSlot(prev, section, newStart, defaultDurationMinutes, fixedDurationEnabled),
    );
  };

  const handleEndChange = (section: number, newEnd: string) => {
    setSlots((prev) => prev.map((s) => (s.section === section ? { ...s, endTime: newEnd } : s)));
  };

  const handleDurationChange = (minutes: number) => {
    const safe = Math.max(15, Math.min(180, minutes));
    setDefaultDurationMinutes(safe);
    if (fixedDurationEnabled) {
      setSlots((prev) =>
        prev.map((s) => ({
          ...s,
          endTime: addMinutesToTime(s.startTime, safe),
        })),
      );
    }
  };

  const handleAddSlot = () => {
    if (slots.length >= 24) return;
    const last = slots[slots.length - 1];
    const nextSection = (last?.section ?? 0) + 1;
    const startTime = last ? addMinutesToTime(last.endTime, 5) : '08:00';
    setSlots((prev) => [
      ...prev,
      {
        section: nextSection,
        startTime,
        endTime: addMinutesToTime(startTime, defaultDurationMinutes),
      },
    ]);
  };

  const handleRemoveLast = (section: number) => {
    if (slots.length <= 1) return;
    setSlots((prev) =>
      prev
        .filter((s) => s.section !== section)
        .map((s, idx) => ({ ...s, section: idx + 1 })),
    );
  };

  const handleResetSwpu = () => {
    setFixedDurationEnabled(true);
    setDefaultDurationMinutes(45);
    setSlots(SWPU_CHENGDU_DEFAULT_SLOTS.map((s) => ({ ...s })));
  };

  const handleSubmit = async () => {
    setSaving(true);
    try {
      await onSave({
        id: timetable.id,
        name: name.trim() || timetable.name,
        fixedDurationEnabled,
        defaultDurationMinutes,
        slots,
      });
      onOpenChange(false);
      notifyToast({ tone: 'success', title: '时间表已保存' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="regular"
      title="编辑时间表"
      description="24 小时制，开启「固定上课时长」后修改上课时间会自动联动下课时间。"
    >
      <div className={styles.dialogContainer}>
        <div className={styles.dialogBody}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>时间表名称</span>
          <Input variant="fill" value={name} onValueChange={setName} />
        </label>

        <div className={styles.settingRow}>
          <div className={styles.settingMeta}>
            <span className={styles.settingTitle}>固定上课时长</span>
            <span className={styles.settingDesc}>修改开始时间时自动按每节时长推算结束时间</span>
          </div>
          <Switch checked={fixedDurationEnabled} onCheckedChange={setFixedDurationEnabled} />
        </div>

        <div className={styles.settingRow}>
          <div className={styles.settingMeta}>
            <span className={styles.settingTitle}>每节课上课时长</span>
            <span className={styles.settingDesc}>西南石油大学标准单节时长为 45 分钟</span>
          </div>
          <div className={styles.inlineRow}>
            <span className={styles.stepperValue}>{defaultDurationMinutes} 分钟</span>
            <Stepper
              min={15}
              max={180}
              step={5}
              value={defaultDurationMinutes}
              onValueChange={handleDurationChange}
            />
          </div>
        </div>

        <div className={styles.inlineRow} style={{ justifyContent: 'space-between' }}>
          <span className={styles.fieldLabel}>共 {slots.length} 节（24 小时制）</span>
          <div className={styles.inlineRow}>
            <Button variant="glass" size="small" icon={<RotateCcw size={13} />} onClick={handleResetSwpu}>
              西柚默认预设
            </Button>
            <Button
              variant="glass"
              size="small"
              icon={<Plus size={13} />}
              disabled={slots.length >= 24}
              onClick={handleAddSlot}
            >
              添加节次
            </Button>
          </div>
        </div>

        <div className={styles.slotList}>
          {slots.map((slot) => (
            <div key={slot.section} className={styles.slotRow}>
              <span className={styles.slotLabel}>第 {slot.section} 节课</span>
              <TimeField
                size="small"
                hourCycle={24}
                value={slot.startTime}
                onValueChange={(v) => v && handleStartChange(slot.section, v)}
                aria-label={`第 ${slot.section} 节开始时间`}
              />
              <span className={styles.slotDash}>-</span>
              <TimeField
                size="small"
                hourCycle={24}
                value={slot.endTime}
                onValueChange={(v) => v && handleEndChange(slot.section, v)}
                aria-label={`第 ${slot.section} 节结束时间`}
              />
              <button
                type="button"
                className={styles.iconBtn}
                disabled={slots.length <= 1}
                aria-label={`删除第 ${slot.section} 节`}
                onClick={() => handleRemoveLast(slot.section)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        </div>

        <div className={styles.dialogFooter}>
          <div className={styles.dialogFooterRight}>
            <Button variant="glass" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button variant="filled" loading={saving} onClick={() => void handleSubmit()}>
              保存时间表
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// ── 3. 课表设置弹窗（开学日期、当前周联动、节数/周数、节假日、提醒） ─────────

interface ScheduleSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: ScheduleDetail;
  timetables: ScheduleTimetable[];
  onSave: (patch: {
    id: string;
    name: string;
    timetableId: string;
    startDate: string;
    weekStartDay: 1 | 7;
    totalWeeks: number;
    maxSections: number;
    reminderEnabled: boolean;
    reminderMinutes: number;
    holidays: string[];
  }) => Promise<void>;
  onOpenTimetable: () => void;
}

export function ScheduleSettingsDialog({
  open,
  onOpenChange,
  detail,
  timetables,
  onSave,
  onOpenTimetable,
}: ScheduleSettingsDialogProps): JSX.Element {
  const s = detail.schedule;
  const [name, setName] = useState(s.name);
  const [timetableId, setTimetableId] = useState(s.timetableId);
  const [startDate, setStartDate] = useState(s.startDate);
  const [weekStartDay, setWeekStartDay] = useState<1 | 7>(s.weekStartDay);
  const [totalWeeks, setTotalWeeks] = useState(s.totalWeeks);
  const [maxSections, setMaxSections] = useState(s.maxSections);
  const [reminderEnabled, setReminderEnabled] = useState(s.reminderEnabled);
  const [reminderMinutes, setReminderMinutes] = useState(s.reminderMinutes);
  const [holidays, setHolidays] = useState<string[]>(s.holidays);
  const [newHolidayDate, setNewHolidayDate] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(s.name);
    setTimetableId(s.timetableId);
    setStartDate(s.startDate);
    setWeekStartDay(s.weekStartDay);
    setTotalWeeks(s.totalWeeks);
    setMaxSections(s.maxSections);
    setReminderEnabled(s.reminderEnabled);
    setReminderMinutes(s.reminderMinutes);
    setHolidays(s.holidays);
    setNewHolidayDate('');
  }, [open, s]);

  const derivedCurrentWeek = Math.max(
    1,
    Math.min(totalWeeks, computeWeekFromStartDate(startDate, new Date(), weekStartDay)),
  );

  const handleCurrentWeekChange = (nextWeek: number) => {
    setStartDate(computeStartDateFromWeek(nextWeek, new Date(), weekStartDay));
  };

  const handleAddHoliday = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newHolidayDate)) return;
    if (!holidays.includes(newHolidayDate)) {
      setHolidays((prev) => [...prev, newHolidayDate].sort());
    }
    setNewHolidayDate('');
  };

  const handleSubmit = async () => {
    setSaving(true);
    try {
      await onSave({
        id: s.id,
        name: name.trim() || s.name,
        timetableId,
        startDate,
        weekStartDay,
        totalWeeks: Math.max(1, Math.min(30, totalWeeks)),
        maxSections: Math.max(8, Math.min(24, maxSections)),
        reminderEnabled,
        reminderMinutes: Math.max(5, Math.min(60, reminderMinutes)),
        holidays,
      });
      onOpenChange(false);
      notifyToast({ tone: 'success', title: '课表设置已保存' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="regular"
      title="课表数据与设置"
      description="配置开学日期、当前周、作息时间表、节假日与课前提醒。"
    >
      <div className={styles.dialogContainer}>
        <div className={styles.dialogBody}>
        <div className={styles.fieldRow}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>课表名称</span>
            <Input variant="fill" value={name} onValueChange={setName} />
          </label>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>绑定上课时间表</span>
            <div className={styles.sectionRangeRow} style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
              <Select
                options={timetables.map((tt) => ({ value: tt.id, label: tt.name }))}
                value={timetableId}
                onValueChange={setTimetableId}
              />
              <Button
                variant="glass"
                size="small"
                onClick={() => {
                  onOpenChange(false);
                  onOpenTimetable();
                }}
              >
                编辑
              </Button>
            </div>
          </div>
        </div>

        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>开学日期（第 1 周第 1 天）</span>
            <DatePicker
              value={startDate}
              clearable={false}
              onValueChange={(v) => v && setStartDate(v)}
              aria-label="选择开学日期"
            />
          </div>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>当前周（修改自动反推开学日期）</span>
            <Select
              options={Array.from({ length: totalWeeks }, (_, i) => ({
                value: String(i + 1),
                label: `第 ${i + 1} 周`,
              }))}
              value={String(derivedCurrentWeek)}
              onValueChange={(v) => handleCurrentWeekChange(Number(v))}
            />
          </div>
        </div>

        <div className={styles.settingRow}>
          <div className={styles.settingMeta}>
            <span className={styles.settingTitle}>每周起始日</span>
            <span className={styles.settingDesc}>调整周视图第一列显示周一或周日</span>
          </div>
          <SegmentedControl
            value={String(weekStartDay)}
            onValueChange={(v) => setWeekStartDay(v === '7' ? 7 : 1)}
            items={[
              { value: '1', label: '周一' },
              { value: '7', label: '周日' },
            ]}
          />
        </div>

        <div className={styles.fieldRow}>
          <div className={styles.settingRow}>
            <div className={styles.settingMeta}>
              <span className={styles.settingTitle}>一天课程节数</span>
              <span className={styles.settingDesc}>8–24 节</span>
            </div>
            <div className={styles.inlineRow}>
              <span className={styles.stepperValue}>{maxSections} 节</span>
              <Stepper min={8} max={24} value={maxSections} onValueChange={setMaxSections} />
            </div>
          </div>
          <div className={styles.settingRow}>
            <div className={styles.settingMeta}>
              <span className={styles.settingTitle}>学期周数</span>
              <span className={styles.settingDesc}>1–30 周</span>
            </div>
            <div className={styles.inlineRow}>
              <span className={styles.stepperValue}>{totalWeeks} 周</span>
              <Stepper min={1} max={30} value={totalWeeks} onValueChange={setTotalWeeks} />
            </div>
          </div>
        </div>

        <div className={styles.settingRow}>
          <div className={styles.settingMeta}>
            <span className={styles.settingTitle}>课前系统提醒</span>
            <span className={styles.settingDesc}>节假日自动静默，上课前发送系统桌面通知</span>
          </div>
          <div className={styles.inlineRow}>
            {reminderEnabled && (
              <div style={{ width: 128 }}>
                <Select
                  options={[
                    { value: '5', label: '提前 5 分钟' },
                    { value: '10', label: '提前 10 分钟' },
                    { value: '15', label: '提前 15 分钟' },
                    { value: '20', label: '提前 20 分钟' },
                    { value: '30', label: '提前 30 分钟' },
                  ]}
                  value={String(reminderMinutes)}
                  onValueChange={(v) => setReminderMinutes(Number(v))}
                />
              </div>
            )}
            <Switch checked={reminderEnabled} onCheckedChange={setReminderEnabled} />
          </div>
        </div>

        <div className={styles.field}>
          <span className={styles.fieldLabel}>节假日（表头显示「休」并自动跳过当日提醒与 .ics 导出）</span>
          <div className={styles.sectionRangeRow} style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
            <DatePicker
              value={newHolidayDate}
              onValueChange={setNewHolidayDate}
              placeholder="选择放假日期"
              aria-label="选择节假日日期"
            />
            <Button variant="glass" size="small" onClick={handleAddHoliday}>
              添加节假日
            </Button>
          </div>
          {holidays.length > 0 && (
            <div className={styles.holidayChips}>
              {holidays.map((d) => (
                <span key={d} className={styles.holidayChip}>
                  {d}
                  <button
                    type="button"
                    className={styles.holidayChipRemove}
                    onClick={() => setHolidays((prev) => prev.filter((x) => x !== d))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        </div>

        <div className={styles.dialogFooter}>
          <div className={styles.dialogFooterRight}>
            <Button variant="glass" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button variant="filled" loading={saving} onClick={() => void handleSubmit()}>
              保存设置
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// ── 4. 多课表管理与新建弹窗 ────────────────────────────────────────────────

interface ScheduleListDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedules: ScheduleSummary[];
  onSelect: (id: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export function ScheduleListDialog({
  open,
  onOpenChange,
  schedules,
  onSelect,
  onCreate,
  onDelete,
}: ScheduleListDialogProps): JSX.Element {
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const handleCreate = async () => {
    const clean = newName.trim();
    if (!clean) return;
    setBusy(true);
    try {
      await onCreate(clean);
      setNewName('');
      notifyToast({ tone: 'success', title: `已新建课表「${clean}」` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="small"
      title="管理课表"
      description="支持创建与切换多张课表（如不同学期、辅修或双学位课表）。"
    >
      <div className={styles.dialogBody}>
        <div className={styles.inlineRow}>
          <Input
            variant="fill"
            value={newName}
            onValueChange={setNewName}
            placeholder="输入新课表名称，如：2026春季课表"
          />
          <Button variant="filled" loading={busy} onClick={() => void handleCreate()}>
            新建
          </Button>
        </div>

        <div className={styles.previewList}>
          {schedules.map((item) => (
            <div key={item.id} className={styles.previewItem}>
              <div
                className={styles.previewItemLeft}
                style={{ flex: 1, cursor: 'pointer' }}
                onClick={() => {
                  void onSelect(item.id).then(() => onOpenChange(false));
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div className={styles.previewItemTitle}>{item.name}</div>
                  <div className={styles.previewItemSub}>
                    {item.courseCount} 门课 · 开学 {item.startDate}
                  </div>
                </div>
              </div>
              <div className={styles.inlineRow}>
                {item.isActive ? (
                  <Tag tone="success">当前</Tag>
                ) : (
                  <Button
                    variant="glass"
                    size="small"
                    icon={<Check size={13} />}
                    onClick={() => void onSelect(item.id)}
                  >
                    切换
                  </Button>
                )}
                <Button
                  variant="glass"
                  size="small"
                  destructive
                  icon={<Trash2 size={13} />}
                  onClick={() => {
                    void onDelete(item.id).then(() =>
                      notifyToast({ tone: 'info', title: `已删除课表「${item.name}」` }),
                    );
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

// ── 5. 分享当前课表 / 导出日历弹窗 ─────────────────────────────────────────

interface ShareScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: ScheduleDetail;
}

export function ShareScheduleDialog({
  open,
  onOpenChange,
  detail,
}: ShareScheduleDialogProps): JSX.Element {
  const [busy, setBusy] = useState<'ics' | 'json' | null>(null);

  const handleExportIcs = async () => {
    setBusy('ics');
    try {
      const res = await getOrbitClient().schedule.exportIcs(detail.schedule.id);
      if (res.cancelled) return;
      if (res.ok) {
        notifyToast({
          tone: 'success',
          title: '已导出标准日历 (.ics)',
          description: res.filePath ? `保存至：${res.filePath}` : '可直接双击导入系统日历或飞书日历',
        });
        onOpenChange(false);
      } else {
        notifyToast({ tone: 'error', title: '导出失败', description: res.message });
      }
    } finally {
      setBusy(null);
    }
  };

  const handleCopyShare = async () => {
    setBusy('json');
    try {
      const res = await getOrbitClient().schedule.exportShareJson(detail.schedule.id);
      if (res.ok) {
        notifyToast({
          tone: 'success',
          title: '已复制课表分享内容',
          description: '好友在 Orbit 课表「导入 → 粘贴分享口令 / JSON」中粘贴即可同步整张课表。',
        });
        onOpenChange(false);
      } else {
        notifyToast({ tone: 'error', title: '复制分享失败', description: res.message });
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="small"
      title="分享当前课表 / 导出日历"
      description={`课表「${detail.schedule.name}」· 共 ${detail.courses.length} 门课程`}
    >
      <div className={styles.dialogBody}>
        <div className={styles.settingRow}>
          <div className={styles.settingMeta}>
            <span className={styles.settingTitle}>导出标准日历 (.ics)</span>
            <span className={styles.settingDesc}>
              按单双周、跳周与节假日精准展开，可导入 Apple 日历 / 飞书日历 / Outlook
            </span>
          </div>
          <Button
            variant="filled"
            size="small"
            icon={<Calendar size={14} />}
            loading={busy === 'ics'}
            onClick={() => void handleExportIcs()}
          >
            导出 .ics
          </Button>
        </div>

        <div className={styles.settingRow}>
          <div className={styles.settingMeta}>
            <span className={styles.settingTitle}>复制分享文本给同班同学</span>
            <span className={styles.settingDesc}>包含完整课程、时间段与作息时间表，免登录教务秒同步</span>
          </div>
          <Button
            variant="glass"
            size="small"
            icon={<Copy size={14} />}
            loading={busy === 'json'}
            onClick={() => void handleCopyShare()}
          >
            复制分享
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
