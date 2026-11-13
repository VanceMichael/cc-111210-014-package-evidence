import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// 临时文件统一后缀，启动时可安全清理：正式文件均通过 rename 落位，
// 进程被杀死后只会残留 *.tmp，绝不会出现索引指向未完整保存资料的情况。
async function atomicWrite(path, bytes) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx' });
  await rename(temporary, path);
}

export class EvidenceLibrary {
  constructor(directory) {
    if (!directory) throw new Error('资料库目录缺失');
    this.directory = directory;
    this.blobs = join(directory, 'blobs');
    this.archives = join(directory, 'archives');
    this.indexPath = join(directory, 'index.json');
    this.manifestPath = join(directory, 'manifest.json');
    this.index = null;
  }

  async open() {
    await mkdir(this.blobs, { recursive: true });
    await mkdir(this.archives, { recursive: true });
    // 清理上次异常退出遗留的临时文件。
    for (const name of await readdir(this.directory).catch(() => [])) {
      if (name.endsWith('.tmp')) await rm(join(this.directory, name), { force: true });
    }
    for (const sub of [this.blobs, this.archives]) {
      for (const name of await readdir(sub).catch(() => [])) {
        if (name.endsWith('.tmp')) await rm(join(sub, name), { force: true });
      }
    }
    try {
      this.index = JSON.parse(await readFile(this.indexPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.index = { version: 1, archives: {}, blobs: {}, rejected: {} };
    }
    await this.#reconcile();
    return this;
  }

  // 索引与磁盘对账：索引引用的对象必须存在且字节摘要一致，否则移除悬空记录。
  async #reconcile() {
    let changed = false;
    for (const [key, record] of Object.entries(this.index.archives)) {
      try {
        const bytes = await readFile(join(this.archives, key));
        if (sha256Hex(bytes) !== record.sha256) throw new Error('摘要不符');
      } catch { delete this.index.archives[key]; changed = true; }
    }
    for (const [key, record] of Object.entries(this.index.blobs)) {
      try {
        const bytes = await readFile(join(this.blobs, key));
        if (sha256Hex(bytes) !== key) throw new Error('摘要不符');
        if (record.bytes !== bytes.length) throw new Error('长度不符');
      } catch { delete this.index.blobs[key]; changed = true; }
    }
    // rejected 只记录结论键，不保存任何不可信字节，无需对账文件。
    // 清理崩溃可能留下的孤儿对象：索引从不指向它们，磁盘上也不应保留。
    for (const [sub, map] of [[this.archives, this.index.archives], [this.blobs, this.index.blobs]]) {
      const referenced = new Set(Object.keys(map));
      for (const name of await readdir(sub).catch(() => [])) {
        if (!name.endsWith('.tmp') && !referenced.has(name)) {
          await rm(join(sub, name), { force: true });
          changed = true;
        }
      }
    }
    if (changed) await this.#flushIndex();
  }

  async #flushIndex() {
    await atomicWrite(this.indexPath, Buffer.from(JSON.stringify(this.index, null, 2)));
  }

  // 返回已校验归档字节；已缓存则不发起任何网络请求。
  async cachedArchive(key) {
    const record = this.index.archives[key];
    if (!record) return null;
    const bytes = await readFile(join(this.archives, key));
    if (sha256Hex(bytes) !== record.sha256) {
      delete this.index.archives[key];
      await this.#flushIndex();
      return null;
    }
    return bytes;
  }

  // 保存已通过完整性校验的归档字节，重复内容只存一份。
  async saveArchive(key, bytes, source) {
    const digest = sha256Hex(bytes);
    if (this.index.archives[key]) return { reused: true, path: join(this.archives, key) };
    await atomicWrite(join(this.archives, key), bytes);
    this.index.archives[key] = { sha256: digest, bytes: bytes.length, source, savedAt: new Date().toISOString() };
    await this.#flushIndex();
    return { reused: false, path: join(this.archives, key) };
  }

  // 保存去重后的许可证/NOTICE 原文，按 sha256 内容寻址。
  async saveBlob(bytes, kind) {
    const key = sha256Hex(bytes);
    if (!this.index.blobs[key]) {
      await atomicWrite(join(this.blobs, key), bytes);
      this.index.blobs[key] = { kind, bytes: bytes.length, savedAt: new Date().toISOString() };
      await this.#flushIndex();
      return { key, reused: false };
    }
    return { key, reused: true };
  }

  // 负缓存：记录“按该约束下载到的字节未通过校验”的结论，重复领取不再下载。
  rejection(cacheKey) {
    return this.index.rejected[cacheKey] ?? null;
  }

  async saveRejection(cacheKey, detail, source) {
    if (this.index.rejected[cacheKey]) return;
    this.index.rejected[cacheKey] = { detail, source, savedAt: new Date().toISOString() };
    await this.#flushIndex();
  }

  async readBlob(key) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('证据标识无效');
    const bytes = await readFile(join(this.blobs, key));
    if (sha256Hex(bytes) !== key) throw new Error('证据校验失败');
    return bytes;
  }

  // 清单最后写入：它只引用此前已落盘并对账过的对象。
  async writeManifest(manifest) {
    await atomicWrite(this.manifestPath, Buffer.from(JSON.stringify(manifest, null, 2)));
    return this.manifestPath;
  }

  async readManifest() {
    return JSON.parse(await readFile(this.manifestPath, 'utf8'));
  }

  stats() {
    return { archives: Object.keys(this.index.archives).length, blobs: Object.keys(this.index.blobs).length };
  }
}
