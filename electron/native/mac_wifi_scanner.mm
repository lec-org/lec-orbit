/**
 * Orbit macOS 进程内原生 Wi-Fi 扫描与定位授权模块（Objective-C++ / Node-API v6，零第三方依赖）。
 *
 * 为什么必须进程内调用 CoreWLAN：
 * - 在 macOS 14+ (Sonoma/Sequoia/Tahoe) 上，locationd 校验 CWNetwork.bssid/ssid 时，
 *   绑定的是实际发起 CoreWLAN 调用的进程身份；通过 /usr/bin/osascript 子进程调用无法继承
 *   Orbit.app 的定位服务权限，导致 BSSID 被系统强制脱敏为 nil 且易因阻塞全信道扫描超时。
 * - 本模块直接加载在 Orbit/Electron 主进程内部，与系统「定位服务」开关 100% 绑定，
 *   通过 napi_create_async_work 在后台线程池执行，绝不阻塞 Electron UI 渲染。
 */
#define NAPI_VERSION 6
#include <node_api.h>

#import <CoreLocation/CoreLocation.h>
#import <CoreWLAN/CoreWLAN.h>
#import <Foundation/Foundation.h>

#include <string>
#include <vector>

namespace {

struct WifiNetworkItem {
  std::string bssid;
  std::string ssid;
  int rssi = -75;
};

struct ScanWorkContext {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  bool forceScan = false;
  bool ok = false;
  std::string reason;
  std::string authStatus;
  std::string source = "scan";
  int totalCount = 0;
  std::vector<WifiNetworkItem> networks;
};

static CLLocationManager* gLocationManager = nil;

/** 查询当前进程在 macOS CoreLocation 下的定位授权状态。 */
std::string GetLocationAuthStatusString() {
  @autoreleasepool {
    CLAuthorizationStatus status = kCLAuthorizationStatusNotDetermined;
    if (@available(macOS 11.0, *)) {
      if (gLocationManager != nil) {
        status = gLocationManager.authorizationStatus;
      } else {
        CLLocationManager* mgr = [[CLLocationManager alloc] init];
        status = mgr.authorizationStatus;
      }
    } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
      status = [CLLocationManager authorizationStatus];
#pragma clang diagnostic pop
    }

    switch (status) {
      case kCLAuthorizationStatusAuthorizedAlways:
        return "authorized";
      case kCLAuthorizationStatusDenied:
        return "denied";
      case kCLAuthorizationStatusRestricted:
        return "restricted";
      case kCLAuthorizationStatusNotDetermined:
      default:
        return "not_determined";
    }
  }
}

/** 若定位授权尚未决定，在主线程队列触发一次原生定位权限弹窗（幂等安全）。 */
void EnsureLocationPermissionRequested() {
  dispatch_async(dispatch_get_main_queue(), ^{
    @autoreleasepool {
      if (gLocationManager == nil) {
        gLocationManager = [[CLLocationManager alloc] init];
      }
      if (@available(macOS 11.0, *)) {
        if (gLocationManager.authorizationStatus == kCLAuthorizationStatusNotDetermined) {
          [gLocationManager requestWhenInUseAuthorization];
        }
      }
    }
  });
}

void ExtractNetworks(NSSet<CWNetwork*>* nets, std::vector<WifiNetworkItem>& out, int& totalCount) {
  out.clear();
  if (nets == nil) {
    totalCount = 0;
    return;
  }
  NSArray<CWNetwork*>* arr = [nets allObjects];
  totalCount = static_cast<int>([arr count]);
  out.reserve(static_cast<size_t>(totalCount));
  for (CWNetwork* n in arr) {
    WifiNetworkItem item;
    if (n.bssid != nil) {
      const char* rawBssid = [n.bssid UTF8String];
      if (rawBssid != nullptr) item.bssid = rawBssid;
    }
    if (n.ssid != nil) {
      const char* rawSsid = [n.ssid UTF8String];
      if (rawSsid != nullptr) item.ssid = rawSsid;
    }
    item.rssi = static_cast<int>(n.rssiValue);
    out.push_back(std::move(item));
  }
}

bool HasAnyVisibleBssid(const std::vector<WifiNetworkItem>& list) {
  for (const auto& item : list) {
    if (!item.bssid.empty()) return true;
  }
  return false;
}

/** 后台线程执行：优先利用系统毫秒级 cachedScanResults，按需执行实时全信道扫描。 */
void ExecuteScanWork(napi_env /*env*/, void* rawData) {
  auto* ctx = static_cast<ScanWorkContext*>(rawData);
  @autoreleasepool {
    ctx->authStatus = GetLocationAuthStatusString();
    if (ctx->authStatus == "not_determined") {
      EnsureLocationPermissionRequested();
    }

    CWWiFiClient* client = [CWWiFiClient sharedWiFiClient];
    CWInterface* iface = client ? [client interface] : nil;
    if (iface == nil) {
      ctx->ok = false;
      ctx->reason = "no_interface";
      return;
    }

    if (![iface powerOn]) {
      ctx->ok = false;
      ctx->reason = "wifi_powered_off";
      return;
    }

    // 读取当前系统缓存扫描结果（毫秒级，避免每次都阻塞触发 2.4G/5G/6G 全频段扫描）
    std::vector<WifiNetworkItem> cachedList;
    int cachedTotal = 0;
    NSSet<CWNetwork*>* cachedNets = [iface cachedScanResults];
    ExtractNetworks(cachedNets, cachedList, cachedTotal);

    if (!ctx->forceScan && cachedTotal > 0 && HasAnyVisibleBssid(cachedList)) {
      ctx->ok = true;
      ctx->source = "cache";
      ctx->totalCount = cachedTotal;
      ctx->networks = std::move(cachedList);
      return;
    }

    // 实时扫描（force=true 或系统缓存暂无有效 BSSID）
    NSError* scanErr = nil;
    NSSet<CWNetwork*>* scannedNets = [iface scanForNetworksWithName:nil error:&scanErr];
    if (scannedNets != nil) {
      std::vector<WifiNetworkItem> scannedList;
      int scannedTotal = 0;
      ExtractNetworks(scannedNets, scannedList, scannedTotal);

      // 若实时扫描为空但缓存有数据，回退缓存提升稳定性
      if (scannedTotal == 0 && cachedTotal > 0) {
        ctx->ok = true;
        ctx->source = "cache";
        ctx->totalCount = cachedTotal;
        ctx->networks = std::move(cachedList);
        return;
      }

      ctx->ok = true;
      ctx->source = "scan";
      ctx->totalCount = scannedTotal;
      ctx->networks = std::move(scannedList);
      return;
    }

    // 实时扫描报错时，若缓存已有数据则优先返回缓存，否则透传错误信息
    if (cachedTotal > 0) {
      ctx->ok = true;
      ctx->source = "cache";
      ctx->totalCount = cachedTotal;
      ctx->networks = std::move(cachedList);
      return;
    }

    ctx->ok = false;
    if (scanErr != nil && scanErr.localizedDescription != nil) {
      const char* desc = [scanErr.localizedDescription UTF8String];
      ctx->reason = desc ? desc : "scan_failed";
    } else {
      ctx->reason = "scan_failed";
    }
  }
}

void CompleteScanWork(napi_env env, napi_status status, void* rawData) {
  auto* ctx = static_cast<ScanWorkContext*>(rawData);

  if (status != napi_ok) {
    napi_value errMsg = nullptr;
    napi_create_string_utf8(env, "原生 Wi-Fi 扫描任务被中断", NAPI_AUTO_LENGTH, &errMsg);
    napi_value errObj = nullptr;
    napi_create_error(env, nullptr, errMsg, &errObj);
    napi_reject_deferred(env, ctx->deferred, errObj);
  } else {
    napi_value resultObj = nullptr;
    napi_create_object(env, &resultObj);

    napi_value vOk = nullptr;
    napi_get_boolean(env, ctx->ok, &vOk);
    napi_set_named_property(env, resultObj, "ok", vOk);

    napi_value vReason = nullptr;
    napi_create_string_utf8(env, ctx->reason.c_str(), ctx->reason.size(), &vReason);
    napi_set_named_property(env, resultObj, "reason", vReason);

    napi_value vAuth = nullptr;
    napi_create_string_utf8(env, ctx->authStatus.c_str(), ctx->authStatus.size(), &vAuth);
    napi_set_named_property(env, resultObj, "authStatus", vAuth);

    napi_value vSource = nullptr;
    napi_create_string_utf8(env, ctx->source.c_str(), ctx->source.size(), &vSource);
    napi_set_named_property(env, resultObj, "source", vSource);

    napi_value vTotal = nullptr;
    napi_create_int32(env, ctx->totalCount, &vTotal);
    napi_set_named_property(env, resultObj, "total", vTotal);

    napi_value arr = nullptr;
    napi_create_array_with_length(env, ctx->networks.size(), &arr);
    for (size_t i = 0; i < ctx->networks.size(); ++i) {
      const auto& item = ctx->networks[i];
      napi_value row = nullptr;
      napi_create_object(env, &row);

      napi_value vBssid = nullptr;
      napi_create_string_utf8(env, item.bssid.c_str(), item.bssid.size(), &vBssid);
      napi_set_named_property(env, row, "bssid", vBssid);

      napi_value vSsid = nullptr;
      napi_create_string_utf8(env, item.ssid.c_str(), item.ssid.size(), &vSsid);
      napi_set_named_property(env, row, "ssid", vSsid);

      napi_value vRssi = nullptr;
      napi_create_int32(env, item.rssi, &vRssi);
      napi_set_named_property(env, row, "rssi", vRssi);

      napi_set_element(env, arr, static_cast<uint32_t>(i), row);
    }
    napi_set_named_property(env, resultObj, "networks", arr);

    napi_resolve_deferred(env, ctx->deferred, resultObj);
  }

  napi_delete_async_work(env, ctx->work);
  delete ctx;
}

napi_value ScanWifi(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  bool forceScan = false;
  if (argc >= 1 && args[0] != nullptr) {
    napi_valuetype type = napi_undefined;
    napi_typeof(env, args[0], &type);
    if (type == napi_boolean) {
      napi_get_value_bool(env, args[0], &forceScan);
    }
  }

  auto* ctx = new ScanWorkContext();
  ctx->forceScan = forceScan;

  napi_value promise = nullptr;
  napi_create_promise(env, &ctx->deferred, &promise);

  napi_value resourceName = nullptr;
  napi_create_string_utf8(env, "OrbitMacWifiScan", NAPI_AUTO_LENGTH, &resourceName);
  napi_create_async_work(
      env,
      nullptr,
      resourceName,
      ExecuteScanWork,
      CompleteScanWork,
      ctx,
      &ctx->work);
  napi_queue_async_work(env, ctx->work);

  return promise;
}

napi_value RequestLocationPermission(napi_env env, napi_callback_info /*info*/) {
  EnsureLocationPermissionRequested();
  const std::string status = GetLocationAuthStatusString();
  napi_value out = nullptr;
  napi_create_string_utf8(env, status.c_str(), status.size(), &out);
  return out;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value fnScan = nullptr;
  napi_create_function(env, "scanWifi", NAPI_AUTO_LENGTH, ScanWifi, nullptr, &fnScan);
  napi_set_named_property(env, exports, "scanWifi", fnScan);

  napi_value fnReq = nullptr;
  napi_create_function(
      env,
      "requestLocationPermission",
      NAPI_AUTO_LENGTH,
      RequestLocationPermission,
      nullptr,
      &fnReq);
  napi_set_named_property(env, exports, "requestLocationPermission", fnReq);

  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
