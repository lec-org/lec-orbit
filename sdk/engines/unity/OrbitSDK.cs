// 放入 Unity 工程 Assets/Scripts/OrbitSDK.cs（配合 Assets/Plugins/WebGL/OrbitBridge.jslib 使用）
using System;
using System.Runtime.InteropServices;
using UnityEngine;

namespace LecOrbit
{
    public class OrbitSDK : MonoBehaviour
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] private static extern int Orbit_IsRunningInOrbit();
        [DllImport("__Internal")] private static extern void Orbit_Toast(string msg, string tone);
        [DllImport("__Internal")] private static extern void Orbit_GetCurrentUserAsync(string goName, string method);
        [DllImport("__Internal")] private static extern void Orbit_StorageSet(string key, string jsonValue);
        [DllImport("__Internal")] private static extern void Orbit_StorageGetAsync(string key, string goName, string method);
#endif

        private Action<string> _onUserCallback;
        private Action<string> _onStorageCallback;

        public static bool IsRunningInOrbit
        {
            get
            {
#if UNITY_WEBGL && !UNITY_EDITOR
                return Orbit_IsRunningInOrbit() == 1;
#else
                return false;
#endif
            }
        }

        public void ShowToast(string message, string tone = "info")
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            Orbit_Toast(message, tone);
#else
            Debug.Log($"[OrbitSDK.Toast:{tone}] {message}");
#endif
        }

        public void RequestCurrentUser(Action<string> onJsonReceived)
        {
            _onUserCallback = onJsonReceived;
#if UNITY_WEBGL && !UNITY_EDITOR
            Orbit_GetCurrentUserAsync(gameObject.name, nameof(OnUserJsonReceived));
#else
            onJsonReceived?.Invoke("{\"userId\":\"unity-editor\",\"displayName\":\"Unity 编辑器调试\"}");
#endif
        }

        public void SaveCloudData(string key, string jsonValue)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            Orbit_StorageSet(key, jsonValue);
#else
            PlayerPrefs.SetString($"orbit_kv_{key}", jsonValue);
#endif
        }

        public void LoadCloudData(string key, Action<string> onJsonReceived)
        {
            _onStorageCallback = onJsonReceived;
#if UNITY_WEBGL && !UNITY_EDITOR
            Orbit_StorageGetAsync(key, gameObject.name, nameof(OnStorageJsonReceived));
#else
            onJsonReceived?.Invoke(PlayerPrefs.GetString($"orbit_kv_{key}", ""));
#endif
        }

        private void OnUserJsonReceived(string json) => _onUserCallback?.Invoke(json);
        private void OnStorageJsonReceived(string json) => _onStorageCallback?.Invoke(json);
    }
}
