#!/usr/bin/env node
/**
 * 仅在 macOS 环境下编译 Orbit 进程内原生 CoreWLAN + CoreLocation N-API 模块：
 * - 非 macOS 平台（Windows / Linux）静默跳过，不产生任何产物；
 * - 零第三方 npm 依赖，直接调用系统 clang++ 编译为 Universal（arm64 + x86_64）单一 .node 文件；
 * - 输出到 resources/native/orbit_wifi_darwin.node，由 electron-builder.yml 的 mac.extraResources
 *   仅在打包 macOS 时打入 Orbit.app/Contents/Resources/native/。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

if (process.platform !== 'darwin') {
  console.log('[build-mac-wifi-addon] 非 macOS 环境，跳过原生 CoreWLAN 模块编译。');
  process.exit(0);
}

const sourceFile = path.join(projectRoot, 'electron', 'native', 'mac_wifi_scanner.mm');
const outDir = path.join(projectRoot, 'resources', 'native');
const outFile = path.join(outDir, 'orbit_wifi_darwin.node');

if (!fs.existsSync(sourceFile)) {
  console.error(`[build-mac-wifi-addon] 未找到源码文件: ${sourceFile}`);
  process.exit(1);
}

// 查找 node_api.h 头文件目录（兼容 nvm / Homebrew / GitHub Actions setup-node）
function resolveNodeIncludeDir() {
  const candidates = [];
  // 1. 当前 node 可执行文件同级 ../include/node
  if (process.execPath) {
    candidates.push(path.resolve(path.dirname(process.execPath), '..', 'include', 'node'));
  }
  // 2. 尝试通过 PATH 中的 node 查询 process.execPath
  try {
    const nodeExec = execFileSync('node', ['-p', 'process.execPath'], {
      encoding: 'utf8',
    }).trim();
    if (nodeExec) {
      candidates.push(path.resolve(path.dirname(nodeExec), '..', 'include', 'node'));
    }
  } catch {
    // 忽略
  }
  // 3. 常见 Homebrew / 系统路径兜底
  candidates.push('/opt/homebrew/include/node', '/usr/local/include/node');

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'node_api.h'))) {
      return dir;
    }
  }
  return null;
}

const includeDir = resolveNodeIncludeDir();
if (!includeDir) {
  console.error('[build-mac-wifi-addon] 未找到 node_api.h，请确认已安装 Node.js 开发头文件。');
  process.exit(1);
}

// 默认同时编入 arm64 + x86_64 通用二进制；如需仅编本机架构可传 --host-only
const hostOnly = process.argv.includes('--host-only');
const requiredArches = hostOnly
  ? [process.arch === 'arm64' ? 'arm64' : 'x86_64']
  : ['arm64', 'x86_64'];
const archArgs = requiredArches.flatMap((a) => ['-arch', a]);

function hasRequiredArches(filePath, arches) {
  try {
    const out = execFileSync('/usr/bin/lipo', ['-archs', filePath], {
      encoding: 'utf8',
    }).trim();
    const present = new Set(out.split(/\s+/).filter(Boolean));
    return arches.every((a) => present.has(a));
  } catch {
    return false;
  }
}

// 增量跳过：仅当产物比源码更新、非空、且通过 lipo -archs 确认包含全部目标架构时才复用
const forceRebuild = process.argv.includes('--force');
if (!forceRebuild && fs.existsSync(outFile)) {
  const srcStat = fs.statSync(sourceFile);
  const outStat = fs.statSync(outFile);
  if (
    outStat.mtimeMs >= srcStat.mtimeMs &&
    outStat.size > 0 &&
    hasRequiredArches(outFile, requiredArches)
  ) {
    console.log(
      `[build-mac-wifi-addon] 产物已是最新且架构匹配 (${requiredArches.join('+')})，跳过重编: ${outFile}`,
    );
    process.exit(0);
  }
}

fs.mkdirSync(outDir, { recursive: true });

const args = [
  '-std=c++17',
  '-ObjC++',
  '-fobjc-arc',
  '-O2',
  '-shared',
  '-undefined',
  'dynamic_lookup',
  '-mmacosx-version-min=11.0',
  ...archArgs,
  `-I${includeDir}`,
  '-framework',
  'Foundation',
  '-framework',
  'CoreWLAN',
  '-framework',
  'CoreLocation',
  sourceFile,
  '-o',
  outFile,
];

console.log(`[build-mac-wifi-addon] 正在编译 macOS 原生 Wi-Fi 模块 (${archArgs.join(' ')})...`);
execFileSync('/usr/bin/clang++', args, { stdio: 'inherit' });

const stat = fs.statSync(outFile);
console.log(
  `[build-mac-wifi-addon] 编译完成: ${outFile} (${(stat.size / 1024).toFixed(1)} KB)`,
);
