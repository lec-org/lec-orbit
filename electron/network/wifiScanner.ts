/** 跨平台周边 Wi-Fi 环境指纹扫描器（仅被动读取附近 802.11 AP 的 BSSID/SSID/RSSI，不依赖 NetBIOS 或局域网防火墙）。 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WifiScanOptions, WifiScanResult } from '../../src/shared/ipc';
import {
  aggregateWifiSamples,
  normalizeBssid,
  parseNetshWlanOutput,
  parseNmcliWifiOutput,
  type RawWifiSample,
} from './wifiParser';

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 20_000;

interface SinglePassResult {
  samples: RawWifiSample[];
  error?: string;
}

const MAC_COREWLAN_JXA = `
ObjC.import("CoreWLAN");
var client = $.CWWiFiClient.sharedWiFiClient;
var iface = client.interface;
if (!iface || iface.isNil()) {
  JSON.stringify({ ok: false, reason: "no_interface", total: 0, networks: [] });
} else {
  var err = Ref();
  var nets = iface.scanForNetworksWithNameError($(), err);
  var out = [];
  if (nets && !nets.isNil()) {
    var arr = nets.allObjects;
    var count = arr.count;
    for (var i = 0; i < count; i++) {
      var n = arr.objectAtIndex(i);
      var bssid = n.bssid && !n.bssid.isNil() ? ObjC.unwrap(n.bssid) : "";
      var ssid = n.ssid && !n.ssid.isNil() ? ObjC.unwrap(n.ssid) : "";
      var rssi = Number(n.rssiValue);
      out.push({ bssid: bssid, ssid: ssid, rssi: isNaN(rssi) ? -75 : rssi });
    }
    JSON.stringify({ ok: true, reason: "", total: out.length, networks: out });
  } else {
    var errMsg = err[0] && !err[0].isNil() ? ObjC.unwrap(err[0].localizedDescription) : "scan_failed";
    JSON.stringify({ ok: false, reason: errMsg, total: 0, networks: [] });
  }
}
`;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scanWindowsOnce(): Promise<SinglePassResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'cmd.exe',
      ['/d', '/s', '/c', 'chcp 65001 >nul && netsh wlan show networks mode=bssid'],
      {
        timeout: 8_000,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const combined = `${stdout ?? ''}\n${stderr ?? ''}`;
    const samples = parseNetshWlanOutput(stdout ?? '');
    if (samples.length > 0) {
      return { samples };
    }
    if (/location|位置|privacy|隐私|permission|拒绝访问/i.test(combined)) {
      return {
        samples: [],
        error: 'Windows 定位权限未开启，系统阻止读取周边 Wi-Fi 列表：请在「设置 → 隐私和安全性 → 位置」中开启定位服务与桌面应用访问权限后重试。',
      };
    }
    if (/wlan autoconfig|无线自动配置|wlansvc|not running|未运行/i.test(combined)) {
      return {
        samples: [],
        error: '当前设备未启用无线网络服务（WLAN AutoConfig），或台式机未安装无线网卡。',
      };
    }
    if (/no wireless interface|没有无线接口|powered down|已关闭/i.test(combined)) {
      return {
        samples: [],
        error: '未检测到开启状态的 Wi-Fi 网卡，请打开本机 Wi-Fi 开关（无需连接任何热点）后重试。',
      };
    }
    return {
      samples: [],
      error: '未扫描到周边 Wi-Fi 信号，请确认本机 Wi-Fi 开关已开启。',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/location|位置|privacy|隐私/i.test(msg)) {
      return {
        samples: [],
        error: 'Windows 定位权限未开启，系统阻止读取周边 Wi-Fi 列表：请在「设置 → 隐私和安全性 → 位置」中开启定位权限后重试。',
      };
    }
    return {
      samples: [],
      error: `读取周边 Wi-Fi 信号失败：${msg}`,
    };
  }
}

async function scanMacOnce(): Promise<SinglePassResult> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_COREWLAN_JXA], {
      timeout: 12_000,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
    const parsed = JSON.parse((stdout ?? '').trim()) as {
      ok?: boolean;
      reason?: string;
      total?: number;
      networks?: Array<{ bssid?: string; ssid?: string; rssi?: number }>;
    };

    if (!parsed.ok) {
      if (parsed.reason === 'no_interface') {
        return {
          samples: [],
          error: '未检测到可用 Wi-Fi 网卡，请确认已打开 Mac 的 Wi-Fi 开关。',
        };
      }
      return {
        samples: [],
        error: `macOS Wi-Fi 扫描失败：${parsed.reason || '未知错误'}`,
      };
    }

    const rawNetworks = Array.isArray(parsed.networks) ? parsed.networks : [];
    const samples: RawWifiSample[] = [];
    for (const item of rawNetworks) {
      const bssid = typeof item.bssid === 'string' ? normalizeBssid(item.bssid) : null;
      if (!bssid) continue;
      samples.push({
        bssid,
        ssid: typeof item.ssid === 'string' ? item.ssid.trim() : '',
        rssi: typeof item.rssi === 'number' && Number.isFinite(item.rssi) ? item.rssi : -75,
      });
    }

    if (samples.length === 0 && (parsed.total ?? rawNetworks.length) > 0) {
      return {
        samples: [],
        error:
          '已检测到周边 Wi-Fi，但 macOS 隐私策略隐藏了路由器 BSSID：请在「系统设置 → 隐私与安全性 → 定位服务」中开启 Orbit 的定位权限后重试。',
      };
    }

    if (samples.length === 0) {
      return {
        samples: [],
        error: '未扫描到周边 Wi-Fi 信号，请确认 Mac 的 Wi-Fi 已开启。',
      };
    }

    return { samples };
  } catch (err) {
    return {
      samples: [],
      error: `macOS Wi-Fi 扫描异常：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function scanLinuxOnce(): Promise<SinglePassResult> {
  try {
    const { stdout } = await execFileAsync('nmcli', ['-t', '-f', 'BSSID,SSID,SIGNAL', 'dev', 'wifi', 'list'], {
      timeout: 8_000,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
    const samples = parseNmcliWifiOutput(stdout ?? '');
    if (samples.length === 0) {
      return {
        samples: [],
        error: '未通过 nmcli 扫描到周边 Wi-Fi 信号，请确认无线网卡已开启。',
      };
    }
    return { samples };
  } catch (err) {
    return {
      samples: [],
      error: `Linux Wi-Fi 扫描失败（需安装 NetworkManager/nmcli）：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function runSinglePlatformScan(): Promise<SinglePassResult> {
  if (process.platform === 'win32') return scanWindowsOnce();
  if (process.platform === 'darwin') return scanMacOnce();
  if (process.platform === 'linux') return scanLinuxOnce();
  return {
    samples: [],
    error: `当前操作系统（${process.platform}）暂不支持周边 Wi-Fi 指纹扫描。`,
  };
}

let cachedResult: WifiScanResult | null = null;
let inFlightSingleScan: Promise<WifiScanResult> | null = null;

/**
 * 扫描周边 Wi-Fi BSSID 与信号强度。
 * - 默认单次扫描并缓存 20 秒，避免轮询频繁唤醒无线扫描；
 * - 签到/签退时传 `force: true` 实时刷新；
 * - 队长采集工作室指纹基线时传 `samples: 3, force: true` 连续采集 3 轮并聚合稳定性。
 */
export async function scanNearbyWifi(options?: WifiScanOptions): Promise<WifiScanResult> {
  const samplesCount = Math.max(1, Math.min(5, Math.floor(options?.samples ?? 1)));
  const force = Boolean(options?.force) || samplesCount > 1;

  if (!force && cachedResult && Date.now() - cachedResult.scannedAt < CACHE_TTL_MS) {
    return cachedResult;
  }

  if (samplesCount === 1 && !force && inFlightSingleScan) {
    return inFlightSingleScan;
  }

  const task = (async (): Promise<WifiScanResult> => {
    const rounds: RawWifiSample[][] = [];
    let lastError: string | undefined;

    for (let i = 0; i < samplesCount; i++) {
      const pass = await runSinglePlatformScan();
      if (pass.samples.length > 0) {
        rounds.push(pass.samples);
      } else if (pass.error) {
        lastError = pass.error;
      }
      if (i + 1 < samplesCount) {
        await delay(process.platform === 'darwin' ? 450 : 850);
      }
    }

    const networks = rounds.length > 0 ? aggregateWifiSamples(rounds) : [];
    const result: WifiScanResult = {
      ok: networks.length > 0,
      platform: process.platform,
      scannedAt: Date.now(),
      rounds: samplesCount,
      networks,
      error: networks.length > 0 ? undefined : lastError || '未扫描到可用周边 Wi-Fi 信号。',
    };

    if (result.ok) {
      cachedResult = result;
    }
    return result;
  })();

  if (samplesCount === 1 && !force) {
    inFlightSingleScan = task.finally(() => {
      inFlightSingleScan = null;
    });
    return inFlightSingleScan;
  }

  return task;
}
