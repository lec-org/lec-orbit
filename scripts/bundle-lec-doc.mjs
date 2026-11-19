/**
 * 将本地 apps/lec-doc/apps/lec-doc 前端构建产物拷贝到 apps/lec-orbit/resources/lec-doc-dist，
 * 供 Orbit 打包（electron-builder extraResources）内置离线秒开。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const orbitRoot = path.resolve(__dirname, '..');
const lecDocClientDir = path.resolve(orbitRoot, '../lec-doc/apps/lec-doc');
const lecDocDistDir = path.join(lecDocClientDir, 'dist');
const targetDir = path.join(orbitRoot, 'resources', 'lec-doc-dist');

const allowMissing = process.argv.includes('--allow-missing');

if (!fs.existsSync(lecDocClientDir)) {
  if (allowMissing) {
    fs.mkdirSync(targetDir, { recursive: true });
    console.warn(`[bundle:doc] 未检测到本地 LecDoc 仓库，已创建占位目录（运行时将自动回退远程模式）：${targetDir}`);
    process.exit(0);
  }
  console.error(`[bundle:doc] 未找到本地 LecDoc 前端目录: ${lecDocClientDir}`);
  process.exit(1);
}

const skipBuild = process.argv.includes('--skip-build');
if (!skipBuild || !fs.existsSync(path.join(lecDocDistDir, 'index.html'))) {
  console.info('[bundle:doc] 正在构建本地 LecDoc 前端产物 (vite build)...');
  execSync('./node_modules/.bin/vite build', {
    cwd: lecDocClientDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      APP_URL: process.env.APP_URL || 'https://doc.lecspace.top',
      LEC_SSO_ISSUER: process.env.LEC_SSO_ISSUER || 'https://sso.lecspace.top/oidc',
      LEC_ORBIT_BUILD: 'true',
    },
  });
}

if (!fs.existsSync(path.join(lecDocDistDir, 'index.html'))) {
  console.error(`[bundle:doc] 构建产物缺失 index.html: ${lecDocDistDir}`);
  process.exit(1);
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(targetDir), { recursive: true });
fs.cpSync(lecDocDistDir, targetDir, { recursive: true });
console.info(`[bundle:doc] 已同步 LecDoc 静态包 -> ${targetDir}`);
