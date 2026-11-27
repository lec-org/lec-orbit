/** 西南石油大学金智教务一键导入向导（同时支持粘贴好友分享 JSON 导入）。 */
import { useEffect, useState, type JSX } from 'react';
import {
  Button,
  Dialog,
  Input,
  Message,
  SegmentedControl,
  Select,
  Tag,
  TextArea,
} from '@lec-space/liquidglass';
import { ExternalLink, RefreshCw, RotateCcw } from 'lucide-react';
import {
  SWPU_SSO_LOGIN_URL,
  getWeekdayName,
  type SwpuNetworkMode,
} from '@shared/schedule';
import { notifyToast } from '@/services/orbitToast';
import { useScheduleStore } from '@/stores/useScheduleStore';
import styles from './Schedule.module.css';

interface SwpuImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SwpuImportDialog({ open, onOpenChange }: SwpuImportDialogProps): JSX.Element {
  const importState = useScheduleStore((s) => s.importState);
  const activeDetail = useScheduleStore((s) => s.activeDetail);
  const openSwpuImport = useScheduleStore((s) => s.openSwpuImport);
  const fetchSwpuSchedule = useScheduleStore((s) => s.fetchSwpuSchedule);
  const closeSwpuImport = useScheduleStore((s) => s.closeSwpuImport);
  const applySwpuImport = useScheduleStore((s) => s.applySwpuImport);
  const importShareJson = useScheduleStore((s) => s.importShareJson);

  const [sourceTab, setSourceTab] = useState<'swpu' | 'share'>('swpu');
  const [networkMode, setNetworkMode] = useState<SwpuNetworkMode>('system');
  const [importMode, setImportMode] = useState<'create' | 'replace'>('create');
  const [scheduleName, setScheduleName] = useState('西南石油大学');
  const [selectedTerm, setSelectedTerm] = useState('');
  const [applying, setApplying] = useState(false);

  const [shareText, setShareText] = useState('');
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareBusy, setShareBusy] = useState(false);

  useEffect(() => {
    if (!importState.preview) return;
    setSelectedTerm(importState.preview.termCode);
    const shortTerm = importState.preview.termName.replace(/学年\s*/, ' ');
    setScheduleName(`西南石油大学 · ${shortTerm}`.slice(0, 50));
  }, [importState.preview]);

  useEffect(() => {
    if (!open && importState.open) {
      void closeSwpuImport();
    }
  }, [open, importState.open, closeSwpuImport]);

  const handleOpenLogin = async (clearSession = false) => {
    await openSwpuImport({ networkMode, clearSession });
  };

  const handleTermChange = async (termCode: string) => {
    setSelectedTerm(termCode);
    await fetchSwpuSchedule(termCode);
  };

  const handleApplySwpu = async () => {
    const preview = importState.preview;
    if (!preview || preview.courses.length === 0) return;
    setApplying(true);
    try {
      await applySwpuImport({
        mode: importMode === 'replace' && activeDetail ? 'replace' : 'create',
        targetScheduleId: activeDetail?.schedule.id,
        scheduleName: scheduleName.trim() || `西南石油大学 · ${preview.termCode}`,
        termCode: preview.termCode,
        startDate: preview.inferredStartDate,
        totalWeeks: 20,
        holidays: preview.holidays,
        courses: preview.courses,
      });
      onOpenChange(false);
    } catch (err) {
      notifyToast({
        tone: 'error',
        title: '保存课表失败',
        description: err instanceof Error ? err.message : '请稍后重试',
      });
    } finally {
      setApplying(false);
    }
  };

  const handleApplyShare = async () => {
    const trimmed = shareText.trim();
    if (!trimmed) {
      setShareError('请先粘贴好友发送的 Orbit 课表分享文本');
      return;
    }
    setShareBusy(true);
    setShareError(null);
    const res = await importShareJson(trimmed);
    setShareBusy(false);
    if (res.ok) {
      setShareText('');
      onOpenChange(false);
      notifyToast({ tone: 'success', title: '已导入好友分享课表' });
    } else {
      setShareError(res.message || '分享内容解析失败');
    }
  };

  const preview = importState.preview;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="large"
      title="导入课程表"
      description="首期原生适配西南石油大学金智教务（登录态仅留在你本机隔离会话中，Orbit 不触碰也不存储教务密码）。"
    >
      <div className={styles.dialogContainer}>
        <div className={styles.dialogBody}>
        <SegmentedControl
          value={sourceTab}
          onValueChange={(v) => setSourceTab(v as 'swpu' | 'share')}
          items={[
            { value: 'swpu', label: '西南石油大学教务' },
            { value: 'share', label: '粘贴分享口令 / JSON' },
          ]}
        />

        {sourceTab === 'swpu' ? (
          <>
            <div className={styles.settingRow}>
              <div className={styles.settingMeta}>
                <span className={styles.settingTitle}>教务网络模式</span>
                <span className={styles.settingDesc}>
                  默认与浏览器一致（跟随系统）；若本机抓包代理拦截导致打不开可切直连或 WebVPN
                </span>
              </div>
              <SegmentedControl
                value={networkMode}
                onValueChange={(v) => setNetworkMode(v as SwpuNetworkMode)}
                items={[
                  { value: 'system', label: '跟随系统' },
                  { value: 'direct', label: '直连' },
                  { value: 'webvpn', label: 'WebVPN' },
                ]}
              />
            </div>

            <div className={styles.inlineRow}>
              <Button
                variant="filled"
                icon={<ExternalLink size={14} />}
                onClick={() => void handleOpenLogin(false)}
              >
                {importState.open ? '聚焦教务登录窗' : '打开西柚教务登录'}
              </Button>
              <Button
                variant="glass"
                icon={<RefreshCw size={14} />}
                disabled={!importState.open || importState.stage === 'fetching'}
                loading={importState.stage === 'fetching'}
                onClick={() => void fetchSwpuSchedule(selectedTerm || undefined)}
              >
                重新抓取
              </Button>
              <Button
                variant="glass"
                icon={<RotateCcw size={14} />}
                onClick={() => void handleOpenLogin(true)}
              >
                切换学号重登
              </Button>
            </div>

            <div className={styles.hintText}>
              入口地址：<code>{SWPU_SSO_LOGIN_URL.slice(0, 68)}…</code>
              <br />
              当前状态：{importState.message}
            </div>

            {importState.error && <Message tone="error">{importState.error}</Message>}

            {preview && (
              <>
                <div className={styles.fieldRow}>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>选择学期（切换即自动重拉）</span>
                    <Select
                      options={preview.terms.map((t) => ({
                        value: t.code,
                        label: `${t.name}${t.selected ? '（当前）' : ''}`,
                      }))}
                      value={selectedTerm}
                      disabled={!importState.open || importState.stage === 'fetching'}
                      onValueChange={(v) => void handleTermChange(v)}
                    />
                  </div>

                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>课表名称</span>
                    <Input
                      variant="fill"
                      value={scheduleName}
                      onValueChange={setScheduleName}
                      placeholder="例如：西南石油大学 · 2026秋"
                    />
                  </label>
                </div>

                {activeDetail && (
                  <div className={styles.settingRow}>
                    <div className={styles.settingMeta}>
                      <span className={styles.settingTitle}>导入方式</span>
                      <span className={styles.settingDesc}>
                        可新建为独立课表，或直接覆盖当前「{activeDetail.schedule.name}」
                      </span>
                    </div>
                    <SegmentedControl
                      value={importMode}
                      onValueChange={(v) => setImportMode(v as 'create' | 'replace')}
                      items={[
                        { value: 'create', label: '新建课表' },
                        { value: 'replace', label: '覆盖当前' },
                      ]}
                    />
                  </div>
                )}

                <div className={styles.inlineRow}>
                  <Tag tone="info">{preview.campus}</Tag>
                  <Tag tone="success">
                    {preview.courseCount} 门课程 · {preview.meetingCount} 条排课
                  </Tag>
                  <Tag tone="neutral">推算开学日：{preview.inferredStartDate}</Tag>
                </div>

                <div className={styles.previewList}>
                  {preview.courses.map((c) => (
                    <div key={`${c.courseCode}-${c.name}`} className={styles.previewItem}>
                      <div className={styles.previewItemLeft}>
                        <span className={styles.colorDot} style={{ backgroundColor: c.color }} />
                        <div style={{ minWidth: 0 }}>
                          <div className={styles.previewItemTitle}>{c.name}</div>
                          <div className={styles.previewItemSub}>
                            {c.meetings
                              .map(
                                (m) =>
                                  `${getWeekdayName(m.dayOfWeek)} ${m.startSection}-${m.endSection}节 ${m.location || ''} (${m.weeksText})`,
                              )
                              .join(' / ')}
                          </div>
                        </div>
                      </div>
                      {c.credit != null && <Tag tone="neutral">{c.credit} 学分</Tag>}
                    </div>
                  ))}
                  {preview.courses.length === 0 && (
                    <Message tone="info">该学期暂未查询到排课记录，可尝试切换其他学期。</Message>
                  )}
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>粘贴好友分享的 Orbit 课表 JSON 文本</span>
              <TextArea
                variant="fill"
                rows={5}
                value={shareText}
                onValueChange={setShareText}
                placeholder='{"format":"orbit-schedule-v1", ...}'
              />
            </div>
            {shareError && <Message tone="error">{shareError}</Message>}
          </>
        )}
        </div>
        {sourceTab === 'swpu' ? (
          <div className={styles.dialogFooter}>
            <div className={styles.dialogFooterRight}>
              <Button variant="glass" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button
                variant="filled"
                disabled={!preview || preview.courses.length === 0}
                loading={applying}
                onClick={() => void handleApplySwpu()}
              >
                确认导入课表
              </Button>
            </div>
          </div>
        ) : (
          <div className={styles.dialogFooter}>
            <div className={styles.dialogFooterRight}>
              <Button variant="glass" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button variant="filled" loading={shareBusy} onClick={() => void handleApplyShare()}>
                导入分享课表
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
