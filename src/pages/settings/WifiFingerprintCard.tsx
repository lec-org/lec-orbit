/** 队长专属：工作室周边 Wi-Fi 环境指纹（BSSID + RSSI）采集、合并与阈值管理卡片。 */
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import {
  Button,
  Card,
  Message,
  SegmentedControl,
  Switch,
  Tag,
} from '@lec-space/liquidglass';
import { RefreshCw, Trash2 } from '@lec-space/icons';
import { Radar, ShieldCheck, Wifi } from 'lucide-react';
import type { ScannedWifiNetwork } from '@shared/ipc';
import type { WifiAnchorItem, WifiFingerprintConfig } from '@shared/punch';
import { getOrbitClient } from '@/services/orbitClient';
import { notifyToast } from '@/services/orbitToast';
import { punchApi, PunchApiError } from '@/services/punchApi';
import { useOrbitStore } from '@/stores/useOrbitStore';
import styles from './Settings.module.css';

function formatRssiLabel(rssi?: number): string {
  if (typeof rssi !== 'number' || Number.isNaN(rssi)) return '未知';
  if (rssi >= -65) return `${rssi} dBm · 极强`;
  if (rssi >= -76) return `${rssi} dBm · 良好`;
  if (rssi >= -84) return `${rssi} dBm · 一般`;
  return `${rssi} dBm · 较弱`;
}

export function WifiFingerprintCard(): JSX.Element {
  const refreshNetworkStatus = useOrbitStore((s) => s.refreshNetworkStatus);

  const [config, setConfig] = useState<WifiFingerprintConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanned, setScanned] = useState<ScannedWifiNetwork[]>([]);
  const [selectedBssids, setSelectedBssids] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [showSavedAnchors, setShowSavedAnchors] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const cfg = await punchApi.fetchWifiFingerprintConfig();
      setConfig(cfg);
    } catch (err) {
      if (err instanceof PunchApiError && err.status === 404) {
        setLoadError('LecPunch 服务端正在更新，暂未开放环境指纹接口，请稍后点击刷新。');
      } else {
        setLoadError(err instanceof Error ? err.message : '加载工作室环境指纹配置失败。');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const savedBssidSet = useMemo(
    () => new Set((config?.anchors ?? []).map((a) => a.bssid.toLowerCase())),
    [config],
  );

  const persistConfig = async (
    next: {
      enabled: boolean;
      anchors: WifiAnchorItem[];
      minMatchCount: number;
      minRssi: number;
      merge?: boolean;
    },
    successTitle: string,
    successDesc?: string,
  ) => {
    setSaving(true);
    try {
      const updated = await punchApi.updateWifiFingerprintConfig(next);
      setConfig(updated);
      notifyToast({
        tone: 'success',
        title: successTitle,
        description: successDesc,
      });
      void refreshNetworkStatus(true);
      return true;
    } catch (err) {
      notifyToast({
        tone: 'error',
        title: '保存工作室环境指纹失败',
        description: err instanceof Error ? err.message : '请稍后重试。',
      });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async (checked: boolean) => {
    if (!config) return;
    if (checked && config.anchors.length === 0) {
      notifyToast({
        tone: 'info',
        title: '请先采集工作室信号点',
        description: '请在工作室内点击下方「采集当前位置信号」，保存至少 1 个固定 Wi-Fi 锚点后再开启校验。',
      });
      return;
    }
    await persistConfig(
      {
        enabled: checked,
        anchors: config.anchors,
        minMatchCount: config.minMatchCount,
        minRssi: config.minRssi,
        merge: false,
      },
      checked ? '已开启工作室环境指纹校验' : '已暂停工作室环境指纹校验',
      checked
        ? `上下卡均需命中至少 ${Math.min(config.minMatchCount, config.anchors.length)} 个锚点（≥ ${config.minRssi} dBm）。`
        : '成员目前不再受周边 Wi-Fi 环境指纹限制。',
    );
  };

  const handleThresholdChange = async (patch: { minMatchCount?: number; minRssi?: number }) => {
    if (!config) return;
    const nextMinMatch = patch.minMatchCount ?? config.minMatchCount;
    const nextMinRssi = patch.minRssi ?? config.minRssi;
    await persistConfig(
      {
        enabled: config.enabled,
        anchors: config.anchors,
        minMatchCount: nextMinMatch,
        minRssi: nextMinRssi,
        merge: false,
      },
      '校验阈值已更新',
      `需命中至少 ${nextMinMatch} 个锚点，信号强度阈值 ${nextMinRssi} dBm。`,
    );
  };

  const handleScanEnvironment = async () => {
    setScanning(true);
    setScanError(null);
    try {
      const res = await getOrbitClient().system.scanWifi({ samples: 3, force: true });
      if (!res.ok || res.networks.length === 0) {
        setScanned([]);
        setSelectedBssids(new Set());
        setScanError(res.error || '未扫描到可用周边 Wi-Fi 信号，请确认已开启本机 Wi-Fi。');
        return;
      }
      setScanned(res.networks);
      const minRssi = config?.minRssi ?? -82;
      const defaultSelected = new Set<string>();
      for (const item of res.networks) {
        if (!item.isLikelyHotspot && item.rssi >= minRssi - 4) {
          defaultSelected.add(item.bssid);
        }
      }
      // 若全部被启发式过滤，则默认勾选前 5 个最强信号供队长手动确认
      if (defaultSelected.size === 0) {
        for (const item of res.networks.slice(0, 5)) {
          defaultSelected.add(item.bssid);
        }
      }
      setSelectedBssids(defaultSelected);
      notifyToast({
        tone: 'info',
        title: `采集完成：发现 ${res.networks.length} 个周边信号点`,
        description: `已自动排除疑似手机热点并预选 ${defaultSelected.size} 个稳定信号，确认后点击保存即可。`,
      });
    } catch (err) {
      setScanError(err instanceof Error ? err.message : '扫描周边 Wi-Fi 失败。');
    } finally {
      setScanning(false);
    }
  };

  const toggleSelectBssid = (bssid: string) => {
    setSelectedBssids((prev) => {
      const next = new Set(prev);
      if (next.has(bssid)) {
        next.delete(bssid);
      } else {
        next.add(bssid);
      }
      return next;
    });
  };

  const handleSaveScanned = async (merge: boolean) => {
    if (!config) return;
    const chosen: WifiAnchorItem[] = scanned
      .filter((item) => selectedBssids.has(item.bssid))
      .map((item) => ({
        bssid: item.bssid,
        ...(item.ssid ? { ssid: item.ssid } : {}),
        sampleRssi: item.rssi,
      }));
    if (chosen.length === 0) {
      notifyToast({
        tone: 'info',
        title: '请至少勾选 1 个信号点',
        description: '建议勾选教学楼/周边教室固定路由器，避免勾选个人手机热点。',
      });
      return;
    }
    const ok = await persistConfig(
      {
        enabled: config.enabled,
        anchors: chosen,
        minMatchCount: config.minMatchCount,
        minRssi: config.minRssi,
        merge,
      },
      merge ? '已追加合并至工作室指纹库' : '已覆盖更新工作室指纹库',
      `本次提交 ${chosen.length} 个信号点；建议在工作室前中后各采集并合并一次，覆盖全部工位。`,
    );
    if (ok) {
      setScanned([]);
      setSelectedBssids(new Set());
      setShowSavedAnchors(true);
    }
  };

  const handleRemoveAnchor = async (bssid: string) => {
    if (!config) return;
    const remaining = config.anchors.filter((a) => a.bssid !== bssid);
    const nextEnabled = remaining.length === 0 ? false : config.enabled;
    await persistConfig(
      {
        enabled: nextEnabled,
        anchors: remaining,
        minMatchCount: config.minMatchCount,
        minRssi: config.minRssi,
        merge: false,
      },
      '已移除信号锚点',
      remaining.length === 0 ? '锚点已清空，环境指纹校验已自动暂停。' : `剩余 ${remaining.length} 个工作室锚点。`,
    );
  };

  return (
    <Card
      title="工作室环境指纹校验（队长管理）"
      extra={
        <div className={styles.wifiHeaderTags}>
          {config && (
            <Tag tone={config.enabled ? 'success' : 'neutral'} icon={<ShieldCheck size={13} />}>
              {config.enabled ? '校验已启用' : '校验未启用'}
            </Tag>
          )}
          <Tag tone="info" icon={<Wifi size={13} />}>
            {config ? `${config.anchors.length} 个锚点` : loading ? '同步中…' : '未加载'}
          </Tag>
        </div>
      }
    >
      <div className={styles.settingList}>
        <p className={styles.wifiLead}>
          团队独立 Wi-Fi 撤除后，通过被动扫描周边固定路由器 / 校园 AP 的硬件 BSSID 与信号强度（无需连接目标 Wi-Fi，不受防火墙 / NetBIOS 限制），确认成员上下卡时身处工作室现场。
        </p>

        {loadError && (
          <Message tone="error">
            {loadError}
          </Message>
        )}

        {config && (
          <>
            <div className={styles.settingRow}>
              <div>
                <div className={styles.settingTitle}>启用上下卡环境指纹校验</div>
                <div className={styles.settingDesc}>
                  开启后，签到与签退均需命中工作室周边指纹；建议先在工作室不同座位多点采集并保存后再开启
                </div>
              </div>
              <Switch
                checked={config.enabled}
                disabled={saving}
                onCheckedChange={(checked) => void handleToggleEnabled(checked)}
              />
            </div>

            <div className={styles.settingRow}>
              <div>
                <div className={styles.settingTitle}>最少命中信号点数量</div>
                <div className={styles.settingDesc}>
                  建议设为 2 个：既防止单个 AP 临时断电误伤，也杜绝单热点伪造
                </div>
              </div>
              <SegmentedControl
                value={String(Math.min(3, Math.max(1, config.minMatchCount)))}
                onValueChange={(v) => void handleThresholdChange({ minMatchCount: Number(v) })}
                items={[
                  { value: '1', label: '1 个' },
                  { value: '2', label: '2 个（推荐）' },
                  { value: '3', label: '3 个' },
                ]}
              />
            </div>

            <div className={styles.settingRow}>
              <div>
                <div className={styles.settingTitle}>最低信号强度门限</div>
                <div className={styles.settingDesc}>
                  过滤隔着几栋楼或走廊远处的微弱信号，防止在工作室外蹭到边角信号打卡
                </div>
              </div>
              <SegmentedControl
                value={
                  config.minRssi >= -78 ? '-75' : config.minRssi <= -85 ? '-88' : '-82'
                }
                onValueChange={(v) => void handleThresholdChange({ minRssi: Number(v) })}
                items={[
                  { value: '-75', label: '严格 -75dBm' },
                  { value: '-82', label: '标准 -82dBm' },
                  { value: '-88', label: '宽松 -88dBm' },
                ]}
              />
            </div>

            <div className={styles.wifiActionBar}>
              <Button
                variant="filled"
                size="small"
                icon={<Radar size={14} />}
                loading={scanning}
                disabled={saving}
                onClick={() => void handleScanEnvironment()}
              >
                {scanning ? '正在连续 3 轮采集…' : '采集当前位置信号'}
              </Button>
              <Button
                variant="glass"
                size="small"
                icon={<RefreshCw size={14} />}
                loading={loading}
                disabled={scanning || saving}
                onClick={() => void loadConfig()}
              >
                刷新配置
              </Button>
              {config.anchors.length > 0 && (
                <Button
                  variant="glass"
                  size="small"
                  onClick={() => setShowSavedAnchors((v) => !v)}
                >
                  {showSavedAnchors
                    ? `收起已保存锚点 (${config.anchors.length})`
                    : `查看已保存锚点 (${config.anchors.length})`}
                </Button>
              )}
            </div>

            {scanError && <Message tone="error">{scanError}</Message>}

            {scanned.length > 0 && (
              <div className={styles.wifiPanel}>
                <div className={styles.wifiPanelHeader}>
                  <div>
                    <div className={styles.settingTitle}>
                      本次采集到 {scanned.length} 个周边信号点（已选 {selectedBssids.size} 个）
                    </div>
                    <div className={styles.settingDesc}>
                      已自动取消勾选疑似个人手机热点；可在工作室门口、中央、靠窗分别采集并点击「追加合并」
                    </div>
                  </div>
                  <div className={styles.wifiQuickBtns}>
                    <Button
                      variant="glass"
                      size="small"
                      onClick={() =>
                        setSelectedBssids(
                          new Set(
                            scanned.filter((n) => !n.isLikelyHotspot).map((n) => n.bssid),
                          ),
                        )
                      }
                    >
                      全选非热点
                    </Button>
                    <Button
                      variant="glass"
                      size="small"
                      onClick={() => setSelectedBssids(new Set())}
                    >
                      清空勾选
                    </Button>
                  </div>
                </div>

                <div className={styles.wifiList}>
                  {scanned.map((net) => {
                    const checked = selectedBssids.has(net.bssid);
                    const alreadySaved = savedBssidSet.has(net.bssid);
                    return (
                      <label
                        key={net.bssid}
                        className={`${styles.wifiItem} ${checked ? styles.wifiItemSelected : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSelectBssid(net.bssid)}
                        />
                        <div className={styles.wifiItemMain}>
                          <div className={styles.wifiItemTop}>
                            <span className={styles.wifiSsid}>
                              {net.ssid || '<隐藏 SSID>'}
                            </span>
                            <code className={styles.wifiBssid}>{net.bssid}</code>
                          </div>
                          <div className={styles.wifiItemSub}>
                            <span>{formatRssiLabel(net.rssi)}</span>
                            <span>
                              稳定性 {net.seenCount}/{net.totalRounds} 轮
                            </span>
                            {alreadySaved && <Tag tone="success">已在库中</Tag>}
                            {net.isLikelyHotspot && <Tag tone="warning">疑似手机热点</Tag>}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>

                <div className={styles.wifiSaveRow}>
                  <Button
                    variant="filled"
                    size="small"
                    loading={saving}
                    disabled={selectedBssids.size === 0}
                    onClick={() => void handleSaveScanned(true)}
                  >
                    追加合并到指纹库（推荐）
                  </Button>
                  <Button
                    variant="glass"
                    size="small"
                    loading={saving}
                    disabled={selectedBssids.size === 0}
                    onClick={() => void handleSaveScanned(false)}
                  >
                    覆盖替换指纹库
                  </Button>
                </div>
              </div>
            )}

            {showSavedAnchors && config.anchors.length > 0 && (
              <div className={styles.wifiPanel}>
                <div className={styles.wifiPanelHeader}>
                  <div className={styles.settingTitle}>
                    已保存的工作室锚点（{config.anchors.length} 个）
                  </div>
                  {config.updatedAt && (
                    <span className={styles.settingDesc}>
                      更新于 {new Date(config.updatedAt).toLocaleString('zh-CN')}
                    </span>
                  )}
                </div>
                <div className={styles.wifiList}>
                  {config.anchors.map((anchor) => (
                    <div key={anchor.bssid} className={styles.wifiSavedRow}>
                      <div className={styles.wifiItemMain}>
                        <div className={styles.wifiItemTop}>
                          <span className={styles.wifiSsid}>
                            {anchor.ssid || '<隐藏 SSID>'}
                          </span>
                          <code className={styles.wifiBssid}>{anchor.bssid}</code>
                        </div>
                        <div className={styles.wifiItemSub}>
                          <span>采样参考：{formatRssiLabel(anchor.sampleRssi)}</span>
                        </div>
                      </div>
                      <Button
                        variant="glass"
                        size="small"
                        destructive
                        disabled={saving}
                        icon={<Trash2 size={13} />}
                        onClick={() => void handleRemoveAnchor(anchor.bssid)}
                      >
                        移除
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
