/** 添加 / 编辑单门课程弹窗：支持同一门课配置多个上课时间段、单双周快捷选择与配色自定义。 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import { Button, ColorSwatchPicker, Dialog, Input, Message, Select } from '@lec-space/liquidglass';
import { Plus, Trash2 } from 'lucide-react';
import {
  COURSE_COLOR_PALETTE,
  formatWeeksCompact,
  parseWeeksExpression,
  type ScheduleCourseWithMeetings,
} from '@shared/schedule';
import styles from './Schedule.module.css';

interface MeetingFormRow {
  key: string;
  id?: string;
  dayOfWeek: number;
  startSection: number;
  endSection: number;
  weeksInput: string;
  teacher: string;
  location: string;
  campus: string;
}

interface CourseEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scheduleId: string;
  totalWeeks: number;
  maxSections: number;
  editingCourse: ScheduleCourseWithMeetings | null;
  /** 从空白网格点击添加时，预填对应的星期与节次 */
  initialSlot?: { dayOfWeek: number; section: number } | null;
  onSave: (payload: {
    scheduleId: string;
    courseId?: string;
    name: string;
    courseCode: string;
    credit: number | null;
    category: string;
    color: string;
    note: string;
    meetings: Array<{
      id?: string;
      teacher: string;
      location: string;
      campus: string;
      dayOfWeek: number;
      startSection: number;
      endSection: number;
      weeks: number[];
      weeksText: string;
      isAdjusted: boolean;
      source: 'manual';
    }>;
  }) => Promise<void>;
  onDelete?: (courseId: string) => Promise<void>;
}

let rowCounter = 1;
function nextKey(): string {
  rowCounter += 1;
  return `mrow_${rowCounter}`;
}

export function CourseEditorDialog({
  open,
  onOpenChange,
  scheduleId,
  totalWeeks,
  maxSections,
  editingCourse,
  initialSlot,
  onSave,
  onDelete,
}: CourseEditorDialogProps): JSX.Element {
  const [name, setName] = useState('');
  const [courseCode, setCourseCode] = useState('');
  const [creditText, setCreditText] = useState('');
  const [category, setCategory] = useState('');
  const [color, setColor] = useState<string>(COURSE_COLOR_PALETTE[0]);
  const [note, setNote] = useState('');
  const [rows, setRows] = useState<MeetingFormRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (editingCourse) {
      setName(editingCourse.name);
      setCourseCode(editingCourse.courseCode);
      setCreditText(editingCourse.credit != null ? String(editingCourse.credit) : '');
      setCategory(editingCourse.category);
      setColor(editingCourse.color || COURSE_COLOR_PALETTE[0]);
      setNote(editingCourse.note);
      setRows(
        editingCourse.meetings.map((m) => ({
          key: nextKey(),
          id: m.id,
          dayOfWeek: m.dayOfWeek,
          startSection: m.startSection,
          endSection: m.endSection,
          weeksInput: m.weeksText || formatWeeksCompact(m.weeks),
          teacher: m.teacher,
          location: m.location,
          campus: m.campus,
        })),
      );
    } else {
      const startSec = initialSlot?.section ?? 1;
      const endSec = Math.min(maxSections, startSec + 1);
      setName('');
      setCourseCode('');
      setCreditText('');
      setCategory('');
      setColor(COURSE_COLOR_PALETTE[Math.floor(Math.random() * COURSE_COLOR_PALETTE.length)]!);
      setNote('');
      setRows([
        {
          key: nextKey(),
          dayOfWeek: initialSlot?.dayOfWeek ?? 1,
          startSection: startSec,
          endSection: endSec,
          weeksInput: `1-${Math.min(16, totalWeeks)}周`,
          teacher: '',
          location: '',
          campus: '成都校区',
        },
      ]);
    }
  }, [open, editingCourse, initialSlot, maxSections, totalWeeks]);

  const weekdayOptions = useMemo(
    () => [
      { value: '1', label: '周一' },
      { value: '2', label: '周二' },
      { value: '3', label: '周三' },
      { value: '4', label: '周四' },
      { value: '5', label: '周五' },
      { value: '6', label: '周六' },
      { value: '7', label: '周日' },
    ],
    [],
  );

  const sectionOptions = useMemo(
    () =>
      Array.from({ length: maxSections }, (_, i) => ({
        value: String(i + 1),
        label: `第 ${i + 1} 节`,
      })),
    [maxSections],
  );

  const updateRow = (key: string, patch: Partial<MeetingFormRow>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const addRow = () => {
    const last = rows[rows.length - 1];
    setRows((prev) => [
      ...prev,
      {
        key: nextKey(),
        dayOfWeek: last ? ((last.dayOfWeek % 7) + 1) : 1,
        startSection: last?.startSection ?? 1,
        endSection: last?.endSection ?? 2,
        weeksInput: last?.weeksInput || `1-${Math.min(16, totalWeeks)}周`,
        teacher: last?.teacher ?? '',
        location: last?.location ?? '',
        campus: last?.campus ?? '成都校区',
      },
    ]);
  };

  const removeRow = (key: string) => {
    setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.key !== key) : prev));
  };

  const handleSubmit = async () => {
    const cleanName = name.trim();
    if (!cleanName) {
      setError('请输入课程名称');
      return;
    }
    const creditNum = creditText.trim() ? Number(creditText.trim()) : null;
    if (creditNum != null && (!Number.isFinite(creditNum) || creditNum < 0)) {
      setError('学分请输入非负数字');
      return;
    }

    const parsedMeetings = [];
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i]!;
      if (r.endSection < r.startSection) {
        setError(`时间段 ${i + 1} 的结束节次不能小于开始节次`);
        return;
      }
      const weeks = parseWeeksExpression(r.weeksInput, totalWeeks);
      if (weeks.length === 0) {
        setError(`时间段 ${i + 1} 的周次格式无法识别，示例：1-16周、1-12(双)、1-9,11-16`);
        return;
      }
      parsedMeetings.push({
        id: r.id,
        teacher: r.teacher.trim(),
        location: r.location.trim(),
        campus: r.campus.trim(),
        dayOfWeek: r.dayOfWeek,
        startSection: r.startSection,
        endSection: r.endSection,
        weeks,
        weeksText: formatWeeksCompact(weeks),
        isAdjusted: false,
        source: 'manual' as const,
      });
    }

    setSaving(true);
    setError(null);
    try {
      await onSave({
        scheduleId,
        courseId: editingCourse?.id,
        name: cleanName,
        courseCode: courseCode.trim(),
        credit: creditNum,
        category: category.trim(),
        color,
        note: note.trim(),
        meetings: parsedMeetings,
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存课程失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="large"
      title={editingCourse ? `编辑课程 · ${editingCourse.name}` : '添加课程'}
      description="支持同一门课添加多个上课时间段，周次支持 1-16周、1-12(双)、1-9,11-16 等写法。"
    >
      <div className={styles.dialogContainer}>
        <div className={styles.dialogBody}>
          <div className={styles.fieldRowTriple}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>课程名称 *</span>
              <Input variant="fill" value={name} onValueChange={setName} placeholder="例如：操作系统" />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>学分</span>
              <Input
                variant="fill"
                value={creditText}
                onValueChange={setCreditText}
                placeholder="如 3.5"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>课程号（可选）</span>
              <Input
                variant="fill"
                value={courseCode}
                onValueChange={setCourseCode}
                placeholder="如 5621571035"
              />
            </label>
          </div>

        <div className={styles.field}>
          <span className={styles.fieldLabel}>卡片配色</span>
          <ColorSwatchPicker
            colors={COURSE_COLOR_PALETTE}
            value={color}
            onValueChange={setColor}
            aria-label="选择课程卡片配色"
          />
        </div>

        <div className={styles.inlineRow} style={{ justifyContent: 'space-between' }}>
          <span className={styles.fieldLabel}>上课时间段（共 {rows.length} 个）</span>
          <Button variant="glass" size="small" icon={<Plus size={13} />} onClick={addRow}>
            添加时间段
          </Button>
        </div>

        {rows.map((row, idx) => (
          <div key={row.key} className={styles.meetingCard}>
            <div className={styles.meetingCardHead}>
              <span>时间段 {idx + 1}</span>
              {rows.length > 1 && (
                <Button
                  variant="glass"
                  size="small"
                  destructive
                  icon={<Trash2 size={12} />}
                  onClick={() => removeRow(row.key)}
                >
                  移除
                </Button>
              )}
            </div>
            <div className={styles.fieldRow}>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>星期</span>
                <Select
                  options={weekdayOptions}
                  value={String(row.dayOfWeek)}
                  onValueChange={(v) => updateRow(row.key, { dayOfWeek: Number(v) })}
                />
              </div>

              <div className={styles.field}>
                <span className={styles.fieldLabel}>节次范围</span>
                <div className={styles.sectionRangeRow}>
                  <Select
                    options={sectionOptions}
                    value={String(row.startSection)}
                    onValueChange={(v) => {
                      const nextStart = Number(v);
                      updateRow(row.key, {
                        startSection: nextStart,
                        endSection: Math.max(nextStart, row.endSection),
                      });
                    }}
                  />
                  <span className={styles.sectionRangeDash}>-</span>
                  <Select
                    options={sectionOptions}
                    value={String(row.endSection)}
                    onValueChange={(v) => updateRow(row.key, { endSection: Number(v) })}
                  />
                </div>
              </div>
            </div>

            <div className={styles.fieldRow}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>上课周次</span>
                <Input
                  variant="fill"
                  value={row.weeksInput}
                  onValueChange={(v) => updateRow(row.key, { weeksInput: v })}
                  placeholder="1-16周 / 1-12(双) / 3,8周"
                />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>快捷周次</span>
                <div className={styles.inlineRow}>
                  <Button
                    variant="glass"
                    size="small"
                    onClick={() => updateRow(row.key, { weeksInput: `1-${Math.min(16, totalWeeks)}周` })}
                  >
                    1-16全
                  </Button>
                  <Button
                    variant="glass"
                    size="small"
                    onClick={() => updateRow(row.key, { weeksInput: `1-${Math.min(16, totalWeeks)}周(单)` })}
                  >
                    单周
                  </Button>
                  <Button
                    variant="glass"
                    size="small"
                    onClick={() => updateRow(row.key, { weeksInput: `1-${Math.min(16, totalWeeks)}周(双)` })}
                  >
                    双周
                  </Button>
                </div>
              </label>
            </div>

            <div className={styles.fieldRow}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>教室 / 地点</span>
                <Input
                  variant="fill"
                  value={row.location}
                  onValueChange={(v) => updateRow(row.key, { location: v })}
                  placeholder="例如：明德楼A204"
                />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>授课教师</span>
                <Input
                  variant="fill"
                  value={row.teacher}
                  onValueChange={(v) => updateRow(row.key, { teacher: v })}
                  placeholder="例如：胡卫东"
                />
              </label>
            </div>
          </div>
        ))}

        <label className={styles.field}>
          <span className={styles.fieldLabel}>备注（可选）</span>
          <Input variant="fill" value={note} onValueChange={setNote} placeholder="作业/实验要求或考试提醒" />
        </label>

        {error && <Message tone="error">{error}</Message>}
        </div>

        <div className={styles.dialogFooter}>
          {editingCourse && onDelete ? (
            <Button
              variant="glass"
              destructive
              loading={deleting}
              disabled={saving}
              icon={<Trash2 size={14} />}
              onClick={async () => {
                if (deleting || saving) return;
                setDeleting(true);
                setError(null);
                try {
                  await onDelete(editingCourse.id);
                  onOpenChange(false);
                } catch (err) {
                  setError(err instanceof Error ? err.message : '删除课程失败，请稍后重试');
                } finally {
                  setDeleting(false);
                }
              }}
            >
              删除课程
            </Button>
          ) : (
            <span />
          )}
          <div className={styles.dialogFooterRight}>
            <Button variant="glass" disabled={saving || deleting} onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button variant="filled" loading={saving} disabled={deleting} onClick={() => void handleSubmit()}>
              保存课程
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
