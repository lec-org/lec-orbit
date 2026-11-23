# 放入 Godot 4 工程并配置为 Autoload 单例（名称：OrbitBridge）
# 说明：若导出 preset 开启了「Thread Support」，请在 orbit.manifest.json 中设置
# runtime.crossOriginIsolated = true，Orbit 会自动注入 COOP/COEP 启用 SharedArrayBuffer。
extends Node

signal user_loaded(user_dict: Dictionary)
signal storage_loaded(key: String, value: Variant)
signal theme_changed(theme: String)

var _is_web: bool = OS.has_feature("web")
var _user_cb_ref
var _theme_cb_ref

func _ready() -> void:
	if not _is_web:
		return
	var sdk = JavaScriptBridge.get_interface("orbitSDK")
	if sdk == null:
		return
	_theme_cb_ref = JavaScriptBridge.create_callback(_on_js_theme_changed)
	sdk.env.onThemeChange(_theme_cb_ref)

func is_in_orbit() -> bool:
	if not _is_web:
		return false
	return JavaScriptBridge.get_interface("orbitSDK") != null

func toast(message: String, tone: String = "info") -> void:
	if not is_in_orbit():
		print("[OrbitBridge.toast:%s] %s" % [tone, message])
		return
	JavaScriptBridge.get_interface("orbitSDK").ui.toast(message, tone)

func request_current_user() -> void:
	if not is_in_orbit():
		user_loaded.emit({"userId": "godot-local", "displayName": "Godot 本地调试"})
		return
	_user_cb_ref = JavaScriptBridge.create_callback(_on_js_user_resolved)
	var sdk = JavaScriptBridge.get_interface("orbitSDK")
	sdk.user.getCurrent().then(_user_cb_ref)

func save_cloud_kv(key: String, value: Variant) -> void:
	if not is_in_orbit():
		return
	var json_str := JSON.stringify(value)
	JavaScriptBridge.eval("window.orbitSDK.storage.set(%s, JSON.parse(%s))" % [JSON.stringify(key), JSON.stringify(json_str)])

func _on_js_user_resolved(args: Array) -> void:
	if args.size() == 0 or args[0] == null:
		user_loaded.emit({})
		return
	var raw := str(JavaScriptBridge.eval("JSON.stringify(arguments[0])"))
	var parsed = JSON.parse_string(raw)
	if parsed is Dictionary:
		user_loaded.emit(parsed)

func _on_js_theme_changed(args: Array) -> void:
	if args.size() > 0:
		theme_changed.emit(str(args[0]))
