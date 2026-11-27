import { useEffect, useState } from 'react';
import { Button, Card, TextArea } from '@lec-space/liquidglass';
import { orbitServerApi } from '@/services/orbitServerApi';
import styles from './Settings.module.css';
import { DutyVersionError, OrbitHttpError } from '@/services/dutySync';

export function DutyScheduleCard() {
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<string | null>(null);
  const [message, setMessage] = useState('读取排班中…');
  const [blocked, setBlocked] = useState<'access' | 'retry' | null>(null);
  function handleError(error: unknown, fallback: string, loading = false) {
    if (error instanceof OrbitHttpError && (error.status === 401 || error.status === 403)) {
      setDraft(''); setSaved(null); setVersion(null); setConflict(false); setLatest(null); setBlocked('access');
      setMessage(error.status === 401 ? '登录已失效，请重新登录。' : '当前账号无权管理排班。');
    } else {
      if (loading || error instanceof DutyVersionError) setBlocked('retry');
      setMessage(error instanceof DutyVersionError ? error.message : fallback);
    }
  }
  useEffect(() => {
    let active = true;
    orbitServerApi.getEditableDutySchedule().then(result => {
      if (!active) return;
      const text = result.groups.map(names => names.join('、')).join('\n');
      setDraft(text); setSaved(text); setVersion(result.version); setMessage(''); setBlocked(null);
    }).catch(error => { if (active) handleError(error, '未能读取排班，请检查服务连接后重试。', true); });
    return () => { active = false; };
  }, [attempt]);

  async function save() {
    const groups = draft.split('\n').filter(line => line.trim()).map(line => line.split(/[、,，]/).map(s => s.trim()).filter(Boolean));
    if (groups.length > 100 || groups.some(g => !g.length || g.length > 100 || g.some(n => n.length > 80))) {
      setMessage('最多 100 组，每组需填写 1–100 个姓名，每个姓名不超过 80 字。'); return;
    }
    setBusy(true);
    try {
      const next = await orbitServerApi.saveDutySchedule(groups, version);
      if (next === null) {
        setConflict(true); setLatest(null); setMessage('排班已在其他设备修改，草稿已保留。请读取最新名单后核对。'); return;
      }
      setVersion(next); setLatest(null);
      const text = groups.map(names => names.join('、')).join('\n');
      setDraft(text); setSaved(text); setMessage(groups.length ? `已保存 ${groups.length} 组排班` : '已清空排班');
    } catch (error) {
      handleError(error, '保存失败，草稿已保留，请重试。');
    }
    finally { setBusy(false); }
  }

  async function compareLatest() {
    setBusy(true);
    try {
      const result = await orbitServerApi.getEditableDutySchedule();
      const text = result.groups.map(names => names.join('、')).join('\n');
      setLatest(text); setSaved(text); setVersion(result.version); setConflict(false); setBlocked(null);
      setMessage('已读取最新排班，请核对并编辑上方草稿后保存。');
    } catch (error) { handleError(error, '读取失败，草稿已保留，请重试。'); }
    finally { setBusy(false); }
  }

  return <Card title="值日生管理" description="每行一组，组内姓名用顿号分隔。首次保存时第 1 组值本周，之后每周一按行序循环。清空后保存可取消排班。">
    <div className={styles.settingList}>
      <TextArea aria-label="按轮换顺序填写值日小组" rows={5} value={draft} disabled={saved === null || busy || blocked !== null}
        placeholder={'张三、李四\n王五、赵六'} onValueChange={text => { setDraft(text); setMessage(''); }} />
      <div className={styles.settingDesc}>修改名单会保留首次排班的起始周。增减或调整小组顺序后，本周值日组可能立即改变。</div>
      <div className={styles.accountActions}>
        <Button disabled={saved === null || saved === draft || busy || conflict || blocked !== null} loading={busy} onClick={() => void save()}>保存排班</Button>
        {(conflict || (blocked === 'retry' && saved !== null)) && <Button disabled={busy} onClick={() => void compareLatest()}>读取最新名单</Button>}
        {blocked === 'retry' && saved === null && <Button onClick={() => { setBlocked(null); setMessage('读取排班中…'); setAttempt(n => n + 1); }}>重试</Button>}
        <span role="status">{message}</span>
      </div>
      {latest !== null && <div>服务器最新排班：<pre>{latest || '暂无排班'}</pre></div>}
    </div>
  </Card>;
}
