/**
 * 零外部依赖的纯 Node ZIP 安全校验与解压器（基于内置 node:zlib + node:crypto）：
 * - 支持 STORED (0) 与 DEFLATE (8) 两种标准压缩方式
 * - 自动防御 Zip Slip（路径穿越）、符号链接逃逸、Zip Bomb（文件数与解压总字节上限）
 * - 智能识别并剥离单层打包目录（例如 macOS 压缩文件夹产生的 `my-app/orbit.manifest.json`）
 * - 内置 SHA256 完整性校验与 `orbit.manifest.json` 强 Schema 校验
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  MINIAPP_MAX_BUNDLE_BYTES,
  MINIAPP_MAX_FILE_COUNT,
  MINIAPP_MAX_UNCOMPRESSED_BYTES,
  OrbitAppManifestSchema,
  type OrbitAppManifest,
} from '../../src/shared/miniapp';

const EOCD_SIGNATURE = 0x06054b50;
const CD_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

export interface ZipEntryMeta {
  rawName: string;
  normalizedName: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  isDirectory: boolean;
  isSymlink: boolean;
}

export interface InspectZipResult {
  manifest: OrbitAppManifest;
  sha256: string;
  compressedBytes: number;
  uncompressedBytes: number;
  fileCount: number;
  stripPrefix: string;
}

export interface ExtractZipOptions {
  expectedSha256?: string;
  maxCompressedBytes?: number;
  maxUncompressedBytes?: number;
  maxFileCount?: number;
}

function normalizeEntryPath(raw: string): string {
  // 统一反斜杠为正斜杠，去掉前导 ./
  const replaced = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!replaced || replaced.includes('\0')) {
    throw new Error(`压缩包内包含非法路径：${raw}`);
  }
  if (replaced.startsWith('/') || /^[a-zA-Z]:/.test(replaced)) {
    throw new Error(`压缩包禁止包含绝对路径：${raw}`);
  }
  const parts = replaced.split('/');
  for (const seg of parts) {
    if (seg === '..') {
      throw new Error(`检测到不安全的路径穿越条目：${raw}`);
    }
  }
  return replaced;
}

function findEocdOffset(buf: Buffer): number {
  const minOffset = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      return i;
    }
  }
  throw new Error('无效的 ZIP 压缩包：未找到 End-of-Central-Directory 标记');
}

export function parseZipCentralDirectory(buf: Buffer): ZipEntryMeta[] {
  if (buf.length < 22) {
    throw new Error('无效的 ZIP 压缩包：文件过小');
  }
  const eocdOffset = findEocdOffset(buf);
  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  if (cdOffset + cdSize > buf.length) {
    throw new Error('ZIP 中央目录越界，压缩包可能已损坏');
  }

  const entries: ZipEntryMeta[] = [];
  let offset = cdOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CD_SIGNATURE) {
      throw new Error('ZIP 中央目录头损坏');
    }
    const compressionMethod = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const externalAttrs = buf.readUInt32LE(offset + 38);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);

    const nameStart = offset + 46;
    const rawName = buf.subarray(nameStart, nameStart + nameLen).toString('utf8');
    offset = nameStart + nameLen + extraLen + commentLen;

    // 忽略 macOS Finder 产生的 __MACOSX 与 .DS_Store 噪声条目
    if (rawName.startsWith('__MACOSX/') || rawName === '__MACOSX' || rawName.endsWith('/.DS_Store') || rawName === '.DS_Store') {
      continue;
    }

    const normalizedName = normalizeEntryPath(rawName);
    const isDirectory = normalizedName.endsWith('/');
    const unixMode = (externalAttrs >>> 16) & 0o170000;
    const isSymlink = unixMode === 0o120000;

    if (isSymlink) {
      throw new Error(`安全校验失败：压缩包禁止包含符号链接 (${rawName})`);
    }

    entries.push({
      rawName,
      normalizedName,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory,
      isSymlink,
    });
  }

  return entries;
}

function readZipEntryData(buf: Buffer, entry: ZipEntryMeta, maxBytes: number): Buffer {
  const lh = entry.localHeaderOffset;
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error(`ZIP 条目本地文件头损坏：${entry.rawName}`);
  }
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const dataStart = lh + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buf.length) {
    throw new Error(`ZIP 条目数据越界：${entry.rawName}`);
  }
  const rawSlice = buf.subarray(dataStart, dataEnd);

  if (entry.compressionMethod === 0) {
    if (rawSlice.length > maxBytes) {
      throw new Error(`ZIP 条目超出允许体积上限：${entry.rawName}`);
    }
    return Buffer.from(rawSlice);
  }
  if (entry.compressionMethod === 8) {
    const inflated = zlib.inflateRawSync(rawSlice, { maxOutputLength: maxBytes });
    return inflated;
  }
  throw new Error(`不支持的 ZIP 压缩算法 (${entry.compressionMethod})：${entry.rawName}`);
}

function detectStripPrefix(entries: ZipEntryMeta[]): string {
  const fileNames = entries.filter((e) => !e.isDirectory).map((e) => e.normalizedName);
  if (fileNames.includes('orbit.manifest.json')) {
    return '';
  }
  const manifestHits = fileNames.filter((name) => name.endsWith('/orbit.manifest.json'));
  if (manifestHits.length === 1) {
    const candidatePrefix = manifestHits[0]!.slice(0, -'orbit.manifest.json'.length);
    if (fileNames.every((name) => name.startsWith(candidatePrefix))) {
      return candidatePrefix;
    }
  }
  return '';
}

export function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function inspectZipBundle(
  zipBuffer: Buffer,
  options: ExtractZipOptions = {},
): { info: InspectZipResult; entries: ZipEntryMeta[] } {
  const maxCompressed = options.maxCompressedBytes ?? MINIAPP_MAX_BUNDLE_BYTES;
  const maxUncompressed = options.maxUncompressedBytes ?? MINIAPP_MAX_UNCOMPRESSED_BYTES;
  const maxFileCount = options.maxFileCount ?? MINIAPP_MAX_FILE_COUNT;

  if (zipBuffer.length > maxCompressed) {
    throw new Error(
      `构建包体积 ${(zipBuffer.length / 1024 / 1024).toFixed(1)} MB 超出上限 ${(maxCompressed / 1024 / 1024).toFixed(0)} MB`,
    );
  }

  const sha256 = sha256Hex(zipBuffer);
  if (options.expectedSha256 && options.expectedSha256.toLowerCase() !== sha256) {
    throw new Error('构建包 SHA256 校验不匹配，已拒绝加载');
  }

  const entries = parseZipCentralDirectory(zipBuffer);
  const files = entries.filter((e) => !e.isDirectory);
  if (files.length === 0) {
    throw new Error('压缩包为空，未包含任何文件');
  }
  if (files.length > maxFileCount) {
    throw new Error(`压缩包文件数 (${files.length}) 超出上限 (${maxFileCount})`);
  }

  let declaredUncompressed = 0;
  for (const f of files) {
    declaredUncompressed += f.uncompressedSize;
    if (declaredUncompressed > maxUncompressed) {
      throw new Error('解压后总体积超出安全上限（防 Zip Bomb）');
    }
  }

  const stripPrefix = detectStripPrefix(entries);
  const manifestEntry = files.find(
    (e) => e.normalizedName === `${stripPrefix}orbit.manifest.json`,
  );
  if (!manifestEntry) {
    throw new Error('压缩包根目录缺少 orbit.manifest.json 清单文件');
  }

  const manifestBuf = readZipEntryData(zipBuffer, manifestEntry, 512 * 1024);
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestBuf.toString('utf8'));
  } catch {
    throw new Error('orbit.manifest.json 不是有效的 JSON 文件');
  }
  const manifest = OrbitAppManifestSchema.parse(manifestJson);

  const expectedEntryPath = `${stripPrefix}${manifest.entry.replace(/^\.\//, '')}`;
  const hasEntry = files.some((f) => f.normalizedName === expectedEntryPath);
  if (!hasEntry) {
    throw new Error(`压缩包中缺少入口文件：${manifest.entry}`);
  }

  return {
    info: {
      manifest,
      sha256,
      compressedBytes: zipBuffer.length,
      uncompressedBytes: declaredUncompressed,
      fileCount: files.length,
      stripPrefix,
    },
    entries,
  };
}

/** 安全原子解压 ZIP 到目标目录（先解到临时目录再替换，避免半成品残留）。 */
export function extractZipBundleSafely(
  zipBuffer: Buffer,
  destDir: string,
  options: ExtractZipOptions = {},
): InspectZipResult {
  const { info, entries } = inspectZipBundle(zipBuffer, options);
  const maxUncompressed = options.maxUncompressedBytes ?? MINIAPP_MAX_UNCOMPRESSED_BYTES;

  const parentDir = path.dirname(destDir);
  fs.mkdirSync(parentDir, { recursive: true });
  const stageDir = path.join(
    parentDir,
    `.stage-${path.basename(destDir)}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
  );
  fs.mkdirSync(stageDir, { recursive: true });

  const stageRoot = path.resolve(stageDir);
  const stagePrefix = `${stageRoot}${path.sep}`;
  let writtenBytes = 0;

  try {
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const rel = info.stripPrefix
        ? entry.normalizedName.slice(info.stripPrefix.length)
        : entry.normalizedName;
      if (!rel || rel.endsWith('/')) continue;

      const targetPath = path.resolve(stageRoot, rel);
      if (!targetPath.startsWith(stagePrefix)) {
        throw new Error(`解压目标路径越界：${entry.rawName}`);
      }

      const remaining = maxUncompressed - writtenBytes;
      if (remaining <= 0) {
        throw new Error('实际解压体积超出安全上限');
      }
      const data = readZipEntryData(zipBuffer, entry, remaining);
      writtenBytes += data.length;
      if (writtenBytes > maxUncompressed) {
        throw new Error('实际解压体积超出安全上限');
      }

      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, data);
    }

    fs.rmSync(destDir, { recursive: true, force: true });
    fs.renameSync(stageDir, destDir);
    return { ...info, uncompressedBytes: writtenBytes };
  } catch (err) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    throw err;
  }
}
