#!/usr/bin/env bash
# Orbit（伴程）macOS 一键安装与升级脚本
# 用法：curl -fsSL https://lec-org.github.io/lec-orbit/install.sh | bash
# 特点：直连 GitHub Releases CDN（无 API 限流）、自动识别 Apple Silicon / Intel、校验 SHA256、自动清除隔离属性并启动。
set -euo pipefail

REPO="lec-org/lec-orbit"
APP_NAME="Orbit.app"
INSTALL_DIR="/Applications"
MANIFEST_URL="https://github.com/${REPO}/releases/latest/download/latest-mac.yml"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "❌ 此脚本仅适用于 macOS。Windows 用户请访问 https://lec-org.github.io/lec-orbit/ 下载安装程序。" >&2
  exit 1
fi

ARCH_RAW="$(uname -m)"
if [[ "$ARCH_RAW" == "arm64" ]]; then
  ARCH="arm64"
else
  ARCH="x64"
fi

echo "==> 检测到 macOS (${ARCH})，正在查询 Orbit 最新正式版..."
MANIFEST="$(curl -fsSL "$MANIFEST_URL")"
VERSION="$(printf '%s\n' "$MANIFEST" | sed -n 's/^version:[[:space:]]*//p' | head -n 1 | tr -d "'\"\r")"

if [[ -z "$VERSION" ]]; then
  echo "❌ 无法解析最新版本号，请前往 https://github.com/${REPO}/releases 手动下载。" >&2
  exit 1
fi

DMG_NAME="Orbit-${VERSION}-mac-${ARCH}.dmg"
DMG_URL="https://github.com/${REPO}/releases/download/v${VERSION}/${DMG_NAME}"
SUMS_URL="https://github.com/${REPO}/releases/download/v${VERSION}/SHA256SUMS.txt"

TMPDIR_WORK="$(mktemp -d)"
MOUNT_POINT=""
cleanup() {
  if [[ -n "$MOUNT_POINT" && -d "$MOUNT_POINT" ]]; then
    hdiutil detach "$MOUNT_POINT" -quiet >/dev/null 2>&1 || hdiutil detach "$MOUNT_POINT" -force -quiet >/dev/null 2>&1 || true
  fi
  rm -rf "$TMPDIR_WORK"
}
trap cleanup EXIT

echo "==> 正在下载 ${DMG_NAME} (v${VERSION})..."
curl -fL --progress-bar "$DMG_URL" -o "${TMPDIR_WORK}/${DMG_NAME}"

if curl -fsSL "$SUMS_URL" -o "${TMPDIR_WORK}/SHA256SUMS.txt" 2>/dev/null; then
  EXPECTED_SHA="$(awk -v f="$DMG_NAME" '$2 == f { print $1 }' "${TMPDIR_WORK}/SHA256SUMS.txt" | head -n 1)"
  if [[ -n "$EXPECTED_SHA" ]]; then
    ACTUAL_SHA="$(shasum -a 256 "${TMPDIR_WORK}/${DMG_NAME}" | awk '{ print $1 }')"
    if [[ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]]; then
      echo "❌ SHA256 校验失败，已中止安装！" >&2
      echo "   期望: ${EXPECTED_SHA}" >&2
      echo "   实际: ${ACTUAL_SHA}" >&2
      exit 1
    fi
    echo "==> SHA256 校验通过 (${ACTUAL_SHA:0:12}...)"
  fi
fi

echo "==> 正在关闭运行中的 Orbit（如有）..."
osascript -e 'tell application "Orbit" to quit' >/dev/null 2>&1 || true
sleep 1
pkill -f "/Applications/Orbit.app/Contents/MacOS/Orbit" >/dev/null 2>&1 || true

echo "==> 正在挂载镜像并安装到 ${INSTALL_DIR}/${APP_NAME}..."
MOUNT_POINT="${TMPDIR_WORK}/mnt"
mkdir -p "$MOUNT_POINT"
hdiutil attach "${TMPDIR_WORK}/${DMG_NAME}" -mountpoint "$MOUNT_POINT" -nobrowse -quiet

if [[ ! -d "${MOUNT_POINT}/${APP_NAME}" ]]; then
  echo "❌ 镜像中未找到 ${APP_NAME}。" >&2
  exit 1
fi

if [[ -w "$INSTALL_DIR" ]]; then
  rm -rf "${INSTALL_DIR}/${APP_NAME}"
  ditto "${MOUNT_POINT}/${APP_NAME}" "${INSTALL_DIR}/${APP_NAME}"
else
  echo "==> 需要管理员权限写入 ${INSTALL_DIR}："
  sudo rm -rf "${INSTALL_DIR}/${APP_NAME}"
  sudo ditto "${MOUNT_POINT}/${APP_NAME}" "${INSTALL_DIR}/${APP_NAME}"
fi

echo "==> 正在移除 macOS 隔离属性 (xattr -cr)..."
xattr -cr "${INSTALL_DIR}/${APP_NAME}" 2>/dev/null || sudo xattr -cr "${INSTALL_DIR}/${APP_NAME}"

echo "✅ Orbit v${VERSION} 安装完成！正在为你启动..."
open -a "${INSTALL_DIR}/${APP_NAME}"
