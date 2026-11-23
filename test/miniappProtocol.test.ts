import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildContainerSecurityHeaders,
  resolveAssetHeaders,
  resolveSafeBundleFile,
} from '../electron/miniapp/protocolHeaders';
import { OrbitAppManifestSchema } from '../src/shared/miniapp';

describe('miniapp protocolHeaders (Cocos / Unity / Godot compatibility)', () => {
  test('Unity WebGL .br 与 .gz 预压缩产物自动返回精准 Content-Type 与 Content-Encoding', () => {
    expect(resolveAssetHeaders('/Build/game.wasm.br')).toEqual({
      contentType: 'application/wasm',
      contentEncoding: 'br',
    });
    expect(resolveAssetHeaders('/Build/game.framework.js.br')).toEqual({
      contentType: 'application/javascript; charset=utf-8',
      contentEncoding: 'br',
    });
    expect(resolveAssetHeaders('/Build/game.data.br')).toEqual({
      contentType: 'application/octet-stream',
      contentEncoding: 'br',
    });
    expect(resolveAssetHeaders('/Build/game.wasm.gz')).toEqual({
      contentType: 'application/wasm',
      contentEncoding: 'gzip',
    });
  });

  test('Godot 4 与 Cocos Creator 常见资源 MIME 识别正确', () => {
    expect(resolveAssetHeaders('/index.pck')).toEqual({
      contentType: 'application/octet-stream',
    });
    expect(resolveAssetHeaders('/index.audio.worklet.js')).toEqual({
      contentType: 'application/javascript; charset=utf-8',
    });
    expect(resolveAssetHeaders('/assets/main/index.mjs')).toEqual({
      contentType: 'application/javascript; charset=utf-8',
    });
    expect(resolveAssetHeaders('/engine.wasm')).toEqual({
      contentType: 'application/wasm',
    });
  });

  test('按 manifest 动态注入 COOP/COEP 与支持 WASM 的严格 CSP', () => {
    const manifest = OrbitAppManifestSchema.parse({
      id: 'godot-demo',
      name: 'Godot Demo',
      version: '1.0.0',
      type: 'minigame',
      engine: 'godot',
      runtime: { crossOriginIsolated: true, isolationPolicy: 'credentialless' },
      permissions: { scopes: ['user.profile'], networkDomains: ['api.example.com'] },
    });

    const docHeaders = buildContainerSecurityHeaders(manifest, { isDocument: true });
    expect(docHeaders['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(docHeaders['Cross-Origin-Embedder-Policy']).toBe('credentialless');
    expect(docHeaders['Content-Security-Policy']).toContain("'wasm-unsafe-eval'");
    expect(docHeaders['Content-Security-Policy']).toContain('https://api.example.com');
    expect(docHeaders['Content-Security-Policy']).toContain("object-src 'none'");

    const nonIsoManifest = OrbitAppManifestSchema.parse({
      id: 'simple-tool',
      name: 'Simple Tool',
      version: '1.0.0',
      runtime: { crossOriginIsolated: false },
    });
    const plainHeaders = buildContainerSecurityHeaders(nonIsoManifest, { isDocument: false });
    expect(plainHeaders['Cross-Origin-Opener-Policy']).toBeUndefined();
    expect(plainHeaders['Cross-Origin-Embedder-Policy']).toBeUndefined();
  });

  test('resolveSafeBundleFile 严格阻断路径穿越并支持 SPA 路由回退', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-proto-test-'));
    try {
      fs.writeFileSync(path.join(dir, 'index.html'), '<h1>ok</h1>');
      fs.mkdirSync(path.join(dir, 'assets'));
      fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');

      expect(resolveSafeBundleFile(dir, '/')).toBe(path.join(dir, 'index.html'));
      expect(resolveSafeBundleFile(dir, '/assets/app.js')).toBe(path.join(dir, 'assets', 'app.js'));
      expect(resolveSafeBundleFile(dir, '/settings/profile')).toBe(path.join(dir, 'index.html'));
      expect(resolveSafeBundleFile(dir, '/../../etc/passwd')).toBeNull();
      expect(resolveSafeBundleFile(dir, '/missing.wasm')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
