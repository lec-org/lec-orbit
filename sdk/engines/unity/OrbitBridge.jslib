/**
 * Unity WebGL JavaScript Plugin（放入 Unity 工程 Assets/Plugins/WebGL/OrbitBridge.jslib）
 * 将 window.orbitSDK 桥接至 C#（通过 SendMessage 回调）。
 */
mergeInto(LibraryManager.library, {
  Orbit_IsRunningInOrbit: function () {
    return window.orbitSDK && window.orbitSDK.isOrbit ? 1 : 0;
  },

  Orbit_Toast: function (msgPtr, tonePtr) {
    var msg = UTF8ToString(msgPtr);
    var tone = UTF8ToString(tonePtr) || 'info';
    if (window.orbitSDK && window.orbitSDK.ui) {
      window.orbitSDK.ui.toast(msg, tone);
    }
  },

  Orbit_GetCurrentUserAsync: function (gameObjectPtr, callbackMethodPtr) {
    var go = UTF8ToString(gameObjectPtr);
    var method = UTF8ToString(callbackMethodPtr);
    if (!window.orbitSDK || !window.orbitSDK.user) {
      SendMessage(go, method, '');
      return;
    }
    window.orbitSDK.user
      .getCurrent()
      .then(function (u) {
        SendMessage(go, method, u ? JSON.stringify(u) : '');
      })
      .catch(function () {
        SendMessage(go, method, '');
      });
  },

  Orbit_StorageSet: function (keyPtr, jsonValuePtr) {
    var key = UTF8ToString(keyPtr);
    var raw = UTF8ToString(jsonValuePtr);
    if (!window.orbitSDK || !window.orbitSDK.storage) return;
    try {
      window.orbitSDK.storage.set(key, JSON.parse(raw));
    } catch (e) {
      window.orbitSDK.storage.set(key, raw);
    }
  },

  Orbit_StorageGetAsync: function (keyPtr, gameObjectPtr, callbackMethodPtr) {
    var key = UTF8ToString(keyPtr);
    var go = UTF8ToString(gameObjectPtr);
    var method = UTF8ToString(callbackMethodPtr);
    if (!window.orbitSDK || !window.orbitSDK.storage) {
      SendMessage(go, method, '');
      return;
    }
    window.orbitSDK.storage
      .get(key)
      .then(function (val) {
        SendMessage(go, method, val === null || val === undefined ? '' : JSON.stringify(val));
      })
      .catch(function () {
        SendMessage(go, method, '');
      });
  },
});
