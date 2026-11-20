/** 跨平台周边 Wi-Fi 扫描输出解析与聚合（纯函数，无 Electron 依赖，便于单元测试）。 */

export interface RawWifiSample {
  bssid: string;
  ssid?: string;
  rssi: number;
}

export interface AggregatedWifiNetwork {
  bssid: string;
  ssid: string;
  rssi: number;
  seenCount: number;
  totalRounds: number;
  isLikelyHotspot: boolean;
}

const HOTSPOT_SSID_PATTERN =
  /(iphone|ipad|androidap|redmi|xiaomi|\bmi[\s_-]?\d|vivo|oppo|realme|oneplus|huawei|honor|nova[\s_-]?\d|pixel|galaxy|samsung|iqoo|meizu|hotspot|热点|的手机|的\s?iphone|个人热点)/i;

const INFRASTRUCTURE_SSID_PATTERN =
  /(campus|eduroam|cmcc|chinanet|chinaunicom|china[_-]?mobile|swpu|wlan|wifi|lab|office|studio|lec|tp-?link|h3c|ruijie|aruba|cisco|meraki|asus|netgear|mercury|tenda|linksys|mikrotik|ubiquiti|unifi|room|building|教学|实验|校园)/i;

/** 规范化 MAC / BSSID 为小写冒号格式；过滤全 0 / 广播地址。 */
export function normalizeBssid(raw: string): string | null {
  const cleaned = raw.trim().replace(/\\:/g, ':').replace(/-/g, ':').toLowerCase();
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(cleaned)) {
    return null;
  }
  if (cleaned === '00:00:00:00:00:00' || cleaned === 'ff:ff:ff:ff:ff:ff') {
    return null;
  }
  return cleaned;
}

/** 将 Windows / nmcli 的百分比信号强度（0~100%）换算为近似 dBm（-100 ~ -50）。 */
export function signalPercentToRssi(percent: number): number {
  const clamped = Math.max(0, Math.min(100, percent));
  return Math.round(clamped / 2 - 100);
}

/** 判断 MAC 地址是否设置了本地管理位（Locally Administered Address，常用于随机 MAC / 手机热点）。 */
export function isLocallyAdministeredMac(bssid: string): boolean {
  const normalized = normalizeBssid(bssid);
  if (!normalized) return false;
  const firstOctet = Number.parseInt(normalized.slice(0, 2), 16);
  if (Number.isNaN(firstOctet)) return false;
  return (firstOctet & 0x02) !== 0;
}

/**
 * 解析 Windows `netsh wlan show networks mode=bssid` 输出。
 * 兼容中英文系统语言：通过 `SSID N :`、`BSSID N : <mac>` 与百分比行（`信号 : 82%` / `Signal : 82%`）提取。
 */
export function parseNetshWlanOutput(stdout: string): RawWifiSample[] {
  const lines = stdout.split(/\r?\n/);
  const byBssid = new Map<string, RawWifiSample>();

  let currentSsid = '';
  let current: { bssid: string; ssid: string; rssi: number; hasSignal: boolean } | null = null;

  const flush = () => {
    if (!current) return;
    const prev = byBssid.get(current.bssid);
    if (!prev || current.rssi > prev.rssi) {
      byBssid.set(current.bssid, {
        bssid: current.bssid,
        ssid: current.ssid || prev?.ssid || '',
        rssi: current.rssi,
      });
    }
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // 匹配顶层 SSID 行（注意避免误匹配 BSSID 行）
    const ssidMatch = /^SSID\s+\d+\s*:\s*(.*)$/i.exec(line);
    if (ssidMatch) {
      flush();
      currentSsid = ssidMatch[1]?.trim() ?? '';
      continue;
    }

    // 匹配 BSSID 行
    const bssidMatch = /^BSSID\s+\d+\s*:\s*([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5})/i.exec(line);
    if (bssidMatch) {
      flush();
      const normalized = normalizeBssid(bssidMatch[1] ?? '');
      if (normalized) {
        current = {
          bssid: normalized,
          ssid: currentSsid,
          rssi: -75,
          hasSignal: false,
        };
      }
      continue;
    }

    if (current && !current.hasSignal) {
      // 兼容「信号 : 84%」「Signal : 84%」等任意系统语言
      const pctMatch = /:\s*(\d{1,3})\s*%/.exec(line);
      if (pctMatch) {
        const pct = Number.parseInt(pctMatch[1] ?? '', 10);
        if (!Number.isNaN(pct) && pct >= 0 && pct <= 100) {
          current.rssi = signalPercentToRssi(pct);
          current.hasSignal = true;
        }
      }
    }
  }

  flush();
  return [...byBssid.values()].sort((a, b) => b.rssi - a.rssi);
}

/**
 * 解析 Linux `nmcli -t -f BSSID,SSID,SIGNAL dev wifi list` 输出。
 * `-t` 模式下 BSSID 内的冒号会被转义为 `\:`。
 */
export function parseNmcliWifiOutput(stdout: string): RawWifiSample[] {
  const byBssid = new Map<string, RawWifiSample>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // 将未转义的冒号拆分，注意保留 \:
    const parts: string[] = [];
    let buf = '';
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\' && i + 1 < line.length && line[i + 1] === ':') {
        buf += ':';
        i++;
      } else if (line[i] === ':') {
        parts.push(buf);
        buf = '';
      } else {
        buf += line[i];
      }
    }
    parts.push(buf);
    if (parts.length < 3) continue;

    const bssid = normalizeBssid(parts[0] ?? '');
    if (!bssid) continue;
    const signalStr = parts[parts.length - 1] ?? '';
    const ssid = parts.slice(1, parts.length - 1).join(':').trim();
    const pct = Number.parseInt(signalStr, 10);
    const rssi = Number.isNaN(pct) ? -75 : signalPercentToRssi(pct);

    const prev = byBssid.get(bssid);
    if (!prev || rssi > prev.rssi) {
      byBssid.set(bssid, { bssid, ssid, rssi });
    }
  }
  return [...byBssid.values()].sort((a, b) => b.rssi - a.rssi);
}

/**
 * 合并多轮扫描结果：计算每个 BSSID 的出现次数、平均 RSSI，并智能标记疑似手机热点。
 */
export function aggregateWifiSamples(rounds: RawWifiSample[][]): AggregatedWifiNetwork[] {
  const totalRounds = Math.max(1, rounds.length);
  const map = new Map<
    string,
    { bssid: string; ssid: string; rssiList: number[]; seenCount: number }
  >();

  for (const round of rounds) {
    const seenInRound = new Set<string>();
    for (const item of round) {
      const bssid = normalizeBssid(item.bssid);
      if (!bssid || seenInRound.has(bssid)) continue;
      seenInRound.add(bssid);

      const safeRssi = Math.max(-100, Math.min(-20, Math.round(item.rssi)));
      const ssid = (item.ssid ?? '').trim();
      const existing = map.get(bssid);
      if (existing) {
        existing.rssiList.push(safeRssi);
        existing.seenCount += 1;
        if (!existing.ssid && ssid) {
          existing.ssid = ssid;
        }
      } else {
        map.set(bssid, {
          bssid,
          ssid,
          rssiList: [safeRssi],
          seenCount: 1,
        });
      }
    }
  }

  // 统计同一 SSID 对应的 BSSID 数量：若校园网/企业多 AP 同名广播多个 BSSID，即使采用 LAA 虚拟 MAC 也不应误判为手机热点
  const ssidBssidCounts = new Map<string, number>();
  for (const entry of map.values()) {
    if (entry.ssid) {
      const key = entry.ssid.toLowerCase();
      ssidBssidCounts.set(key, (ssidBssidCounts.get(key) ?? 0) + 1);
    }
  }

  const results: AggregatedWifiNetwork[] = [];
  for (const entry of map.values()) {
    const avgRssi = Math.round(
      entry.rssiList.reduce((sum, val) => sum + val, 0) / Math.max(1, entry.rssiList.length),
    );
    const ssidLower = entry.ssid.toLowerCase();
    const multiApSameSsid = ssidLower ? (ssidBssidCounts.get(ssidLower) ?? 0) >= 2 : false;
    const matchesHotspotName = Boolean(entry.ssid && HOTSPOT_SSID_PATTERN.test(entry.ssid));
    const matchesInfraName = Boolean(entry.ssid && INFRASTRUCTURE_SSID_PATTERN.test(entry.ssid));
    const isLaa = isLocallyAdministeredMac(entry.bssid);

    const isLikelyHotspot =
      matchesHotspotName || (isLaa && !multiApSameSsid && !matchesInfraName);

    results.push({
      bssid: entry.bssid,
      ssid: entry.ssid,
      rssi: avgRssi,
      seenCount: entry.seenCount,
      totalRounds,
      isLikelyHotspot,
    });
  }

  return results.sort((a, b) => {
    if (a.isLikelyHotspot !== b.isLikelyHotspot) {
      return a.isLikelyHotspot ? 1 : -1;
    }
    if (b.seenCount !== a.seenCount) {
      return b.seenCount - a.seenCount;
    }
    return b.rssi - a.rssi;
  });
}
