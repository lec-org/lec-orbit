/**
 * L1 敏感凭据层：使用 Electron safeStorage（macOS Keychain / Windows DPAPI）加密落盘。
 * 绝不以明文形式写入 config.json 或 localStorage。
 */
import { safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

interface SecretBundle {
  refreshTokens: Record<string, string>;
}

const emptyBundle = (): SecretBundle => ({ refreshTokens: {} });

export class SecretStore {
  private readonly filePath: string;
  private cache: SecretBundle | null = null;

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, 'secrets.enc');
  }

  private ensureAvailable(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统安全存储不可用，无法安全保存登录凭据。');
    }
  }

  private load(): SecretBundle {
    if (this.cache) return this.cache;
    if (!fs.existsSync(this.filePath)) {
      this.cache = emptyBundle();
      return this.cache;
    }
    this.ensureAvailable();
    try {
      const cipher = fs.readFileSync(this.filePath);
      const plain = safeStorage.decryptString(cipher);
      const parsed = JSON.parse(plain) as Partial<SecretBundle>;
      this.cache = {
        refreshTokens:
          parsed.refreshTokens && typeof parsed.refreshTokens === 'object'
            ? { ...parsed.refreshTokens }
            : {},
      };
      return this.cache;
    } catch {
      this.cache = emptyBundle();
      return this.cache;
    }
  }

  private persist(bundle: SecretBundle): void {
    this.ensureAvailable();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify(bundle));
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, encrypted, { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Windows 忽略 POSIX chmod
    }
    this.cache = bundle;
  }

  getRefreshToken(scopeKey: string): string | null {
    return this.load().refreshTokens[scopeKey] ?? null;
  }

  setRefreshToken(scopeKey: string, token: string): void {
    const bundle = this.load();
    bundle.refreshTokens[scopeKey] = token;
    this.persist(bundle);
  }

  deleteRefreshToken(scopeKey: string): void {
    const bundle = this.load();
    if (!(scopeKey in bundle.refreshTokens)) return;
    delete bundle.refreshTokens[scopeKey];
    this.persist(bundle);
  }

  clearAll(): void {
    this.cache = emptyBundle();
    if (fs.existsSync(this.filePath)) {
      fs.rmSync(this.filePath, { force: true });
    }
  }
}
