import { describe, expect, test } from 'bun:test';
import {
  aggregateWifiSamples,
  isLocallyAdministeredMac,
  normalizeBssid,
  parseNetshWlanOutput,
  parseNmcliWifiOutput,
  signalPercentToRssi,
} from '../electron/network/wifiParser';

describe('wifiParser', () => {
  test('normalizeBssid 规范化 MAC 并过滤非法/全零/广播地址', () => {
    expect(normalizeBssid('AA-BB-CC-DD-EE-FF')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeBssid(' 10\\:20\\:30\\:40\\:50\\:60 ')).toBe('10:20:30:40:50:60');
    expect(normalizeBssid('00:00:00:00:00:00')).toBeNull();
    expect(normalizeBssid('ff:ff:ff:ff:ff:ff')).toBeNull();
    expect(normalizeBssid('not-a-mac')).toBeNull();
  });

  test('signalPercentToRssi 按标准公式换算 dBm', () => {
    expect(signalPercentToRssi(100)).toBe(-50);
    expect(signalPercentToRssi(80)).toBe(-60);
    expect(signalPercentToRssi(40)).toBe(-80);
    expect(signalPercentToRssi(0)).toBe(-100);
  });

  test('isLocallyAdministeredMac 正确识别随机 MAC 本地管理位', () => {
    expect(isLocallyAdministeredMac('02:aa:bb:cc:dd:ee')).toBe(true);
    expect(isLocallyAdministeredMac('da:11:22:33:44:55')).toBe(true);
    expect(isLocallyAdministeredMac('00:11:22:33:44:55')).toBe(false);
    expect(isLocallyAdministeredMac('c4:ff:1f:01:02:03')).toBe(false);
  });

  test('parseNetshWlanOutput 解析中文 Windows netsh 输出', () => {
    const sampleZh = `
接口名称 : WLAN
当前有 3 个网络可见。

SSID 1 : SWPU-WLAN
    网络类型            : 结构
    身份验证            : 开放
    加密                : 无
    BSSID 1                 : 10:20:30:40:50:61
         信号             : 86%
         无线电类型         : 802.11ax
         频道               : 36
    BSSID 2                 : 10:20:30:40:50:62
         信号             : 64%
         无线电类型         : 802.11n

SSID 2 :
    网络类型            : 结构
    BSSID 1                 : c4:ff:1f:11:22:33
         信号             : 72%

SSID 3 : 张三的 iPhone
    网络类型            : 结构
    BSSID 1                 : da:11:22:33:44:55
         信号             : 96%
`;
    const parsed = parseNetshWlanOutput(sampleZh);
    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toEqual({ bssid: 'da:11:22:33:44:55', ssid: '张三的 iPhone', rssi: -52 });
    expect(parsed[1]).toEqual({ bssid: '10:20:30:40:50:61', ssid: 'SWPU-WLAN', rssi: -57 });
    expect(parsed[2]).toEqual({ bssid: 'c4:ff:1f:11:22:33', ssid: '', rssi: -64 });
    expect(parsed[3]).toEqual({ bssid: '10:20:30:40:50:62', ssid: 'SWPU-WLAN', rssi: -68 });
  });

  test('parseNetshWlanOutput 解析英文 Windows netsh 输出', () => {
    const sampleEn = `
Interface name : Wi-Fi
There are 1 networks currently visible.

SSID 1 : Lab-502
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    BSSID 1                 : 28:6c:07:aa:bb:cc
         Signal             : 78%
         Radio type         : 802.11ac
         Channel            : 149
`;
    const parsed = parseNetshWlanOutput(sampleEn);
    expect(parsed).toEqual([{ bssid: '28:6c:07:aa:bb:cc', ssid: 'Lab-502', rssi: -61 }]);
  });

  test('parseNmcliWifiOutput 正确处理转义冒号与含冒号 SSID', () => {
    const sampleNmcli = [
      '10\\:20\\:30\\:40\\:50\\:61:Room:502-WiFi:80',
      'C4\\:FF\\:1F\\:11\\:22\\:33::50',
    ].join('\n');
    const parsed = parseNmcliWifiOutput(sampleNmcli);
    expect(parsed).toEqual([
      { bssid: '10:20:30:40:50:61', ssid: 'Room:502-WiFi', rssi: -60 },
      { bssid: 'c4:ff:1f:11:22:33', ssid: '', rssi: -75 },
    ]);
  });

  test('aggregateWifiSamples 多轮聚合、识别手机热点并保护多 AP 校园网虚拟 BSSID', () => {
    const aggregated = aggregateWifiSamples([
      [
        // 校园网多 AP 同名（含 LAA 位也不应误判为手机热点）
        { bssid: '02:11:22:33:44:01', ssid: 'SWPU-Campus', rssi: -60 },
        { bssid: '02:11:22:33:44:02', ssid: 'SWPU-Campus', rssi: -70 },
        // 个人手机热点（名字命中 + LAA 位）
        { bssid: 'da:aa:bb:cc:dd:ee', ssid: '陈信豪的iPhone', rssi: -45 },
        // 未知名字且单个随机 LAA MAC
        { bssid: '06:99:88:77:66:55', ssid: 'MyDevice', rssi: -55 },
      ],
      [
        { bssid: '02:11:22:33:44:01', ssid: 'SWPU-Campus', rssi: -64 },
        { bssid: '02:11:22:33:44:02', ssid: 'SWPU-Campus', rssi: -72 },
        { bssid: 'da:aa:bb:cc:dd:ee', ssid: '陈信豪的iPhone', rssi: -47 },
      ],
    ]);

    const campus1 = aggregated.find((n) => n.bssid === '02:11:22:33:44:01');
    const campus2 = aggregated.find((n) => n.bssid === '02:11:22:33:44:02');
    const iphone = aggregated.find((n) => n.bssid === 'da:aa:bb:cc:dd:ee');
    const randomSingle = aggregated.find((n) => n.bssid === '06:99:88:77:66:55');

    expect(campus1?.isLikelyHotspot).toBe(false);
    expect(campus1?.seenCount).toBe(2);
    expect(campus1?.rssi).toBe(-62);
    expect(campus2?.isLikelyHotspot).toBe(false);
    expect(iphone?.isLikelyHotspot).toBe(true);
    expect(randomSingle?.isLikelyHotspot).toBe(true);
    // 非热点应排在热点之前
    expect(aggregated[0]?.isLikelyHotspot).toBe(false);
    expect(aggregated[aggregated.length - 1]?.isLikelyHotspot).toBe(true);
  });
});
