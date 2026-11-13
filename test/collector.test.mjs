import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture, archive, integrity } from '../fixtures/source.mjs';
import { EvidenceLibrary } from '../src/evidence-library.mjs';
import { collect, STATUS } from '../src/collector.mjs';
import { fetchLock, lockedPackages, componentId } from '../src/connector.mjs';
import { parseIntegrity, verifyIntegrity } from '../src/integrity.mjs';
import { readTarEntries } from '../src/tar-reader.mjs';
import { extractEvidence } from '../src/license-extract.mjs';
import { gunzipSync } from 'node:zlib';

async function freshLibrary() {
  const directory = await mkdtemp(join(tmpdir(), 'license-test-'));
  return { directory, library: await new EvidenceLibrary(directory).open() };
}

async function runCollect(source) {
  const { directory, library } = await freshLibrary();
  const lock = await fetchLock(source.url);
  const manifest = await collect(lock, library, { base: source.url });
  return { directory, library, manifest, lock };
}

test('SRI 解析与常量时间校验识别污染字节', () => {
  const constraints = parseIntegrity(integrity);
  assert.equal(verifyIntegrity(archive, constraints).ok, true);
  assert.equal(verifyIntegrity(Buffer.concat([archive, Buffer.from([1])]), constraints).ok, false);
  assert.throws(() => parseIntegrity('not-a-hash'), /无法解析/);
  assert.throws(() => parseIntegrity('md5-xxxx'), /不支持/);
});

test('tar 解析器只读内存并拒绝坏 checksum 与截断', () => {
  const entries = readTarEntries(gunzipSync(archive));
  assert.ok(entries.some(entry => entry.name === 'package/docs/LICENSE'));
  assert.ok(entries.every(entry => Buffer.isBuffer(entry.content)));
  const broken = Buffer.from(gunzipSync(archive));
  broken[0] = broken[0] === 0 ? 1 : 0;
  assert.throws(() => readTarEntries(broken), /校验和/);
});

test('嵌套许可证与 NOTICE 被分为不同资料，脚本只登记不执行', () => {
  const result = extractEvidence(archive, gunzipSync);
  assert.equal(result.licenses[0].path, 'docs/LICENSE');
  assert.equal(result.notices[0].path, 'NOTICE');
  assert.equal(result.lifecycleScripts.install, 'never-run');
});

test('锁文件条目区分别名、版本共存、嵌套与 workspace 链接', async () => {
  const source = await startFixture();
  try {
    const lock = await fetchLock(source.url);
    const entries = lockedPackages(lock);
    assert.equal(entries.length, 11);
    const aliased = entries.find(entry => entry.installedName === 'renamed');
    assert.equal(aliased.name, 'fixture-lib');
    assert.ok(aliased.alias);
    const versions = entries.filter(entry => entry.name === 'fixture-lib').map(entry => entry.version).sort();
    assert.deepEqual(versions, ['1.0.0', '1.0.0', '1.0.0', '1.1.0']);
    const nested = entries.find(entry => entry.path === 'node_modules/host/node_modules/fixture-lib');
    assert.ok(nested.nested);
    const linked = entries.find(entry => entry.link);
    assert.equal(linked.installedName, 'local');
    const ids = new Set(entries.map(componentId));
    assert.equal(ids.size, entries.length);
  } finally { await source.close(); }
});

test('全量领取产出明确状态矩阵', async () => {
  const source = await startFixture();
  try {
    const { directory, manifest } = await runCollect(source);
    const byId = Object.fromEntries(manifest.components.map(component => [component.lockPath, component]));
    assert.equal(byId['node_modules/fixture-lib'].status, STATUS.COLLECTED);
    assert.equal(byId['node_modules/renamed'].status, STATUS.COLLECTED);
    assert.equal(byId['node_modules/fixture-lib-1x'].status, STATUS.COLLECTED);
    assert.equal(byId['node_modules/host/node_modules/fixture-lib'].status, STATUS.COLLECTED);
    assert.equal(byId['node_modules/conflict-pkg'].status, STATUS.DIGEST_MISMATCH);
    assert.equal(byId['node_modules/no-license-pkg'].status, STATUS.MISSING_LICENSE);
    assert.equal(byId['node_modules/drift-pkg'].status, STATUS.DIGEST_MISMATCH);
    assert.equal(byId['node_modules/denied-pkg'].status, STATUS.SOURCE_DENIED);
    assert.equal(byId['node_modules/unresolved-pkg'].status, STATUS.UNRESOLVED);
    assert.equal(byId['node_modules/missing-tarball'].status, STATUS.FETCH_FAILED);
    assert.equal(byId['node_modules/local'].status, STATUS.WORKSPACE_LINK);
    assert.ok(manifest.summary.failures >= 5);
    // 观察到的可变标签漂移被记录，但没有改变锁定版本的领取对象。
    assert.ok(manifest.mutableTagsObserved.some(drift => drift.latest === '2.0.0' && drift.pinned === '1.0.0'));
    await rm(directory, { recursive: true, force: true });
  } finally { await source.close(); }
});

test('重复领取命中已校验缓存，不重新下载字节', async () => {
  const source = await startFixture();
  try {
    const first = await runCollect(source);
    const before = source.requestCounts['/tar/fixture-lib-1.0.0.tgz'];
    const lock = await fetchLock(source.url);
    // 复用同一资料库实例：已校验归档应直接命中缓存。
    const secondManifest = await collect(lock, first.library, { base: source.url });
    const after = source.requestCounts['/tar/fixture-lib-1.0.0.tgz'];
    assert.equal(after, before, '归档请求次数不应增加');
    assert.ok(secondManifest.summary.downloads === 0);
    assert.ok(secondManifest.summary.cacheHits > 0);
    // 两个 1.0.0 安装（含别名与嵌套）共享同一份许可证/NOTICE：证据引用数多于磁盘 blob 数。
    const blobs = await readdir(join(first.directory, 'blobs'));
    const referenced = new Set();
    let evidenceCount = 0;
    for (const component of secondManifest.components) {
      for (const evidence of component.evidence ?? []) {
        referenced.add(evidence.sha256);
        evidenceCount++;
      }
    }
    for (const blobName of blobs) assert.ok(referenced.has(blobName), `未被清单引用的 blob: ${blobName}`);
    assert.equal(blobs.length, referenced.size);
    assert.ok(evidenceCount > referenced.size, '共享许可证应去重为单一 blob');
    await rm(first.directory, { recursive: true, force: true });
  } finally { await source.close(); }
});

test('资料库写入全部原子化，崩溃后索引不指向悬空资料', async () => {
  const source = await startFixture();
  try {
    const { directory, library, manifest } = await runCollect(source);
    // 模拟崩溃残留：临时文件应在再次打开时被清理。
    await writeFile(join(directory, 'blobs', 'stray.tmp'), 'x');
    await writeFile(join(directory, 'index.json.leftover.tmp'), 'x');
    const reopened = await new EvidenceLibrary(directory).open();
    const names = await readdir(directory);
    assert.ok(!names.some(name => name.endsWith('.tmp')));
    // 损坏一个 blob 后对账应剔除悬空索引，且读取显式报错。
    const anyBlob = Object.keys(reopened.index.blobs)[0];
    await writeFile(join(directory, 'blobs', anyBlob), Buffer.from('tampered'));
    const healed = await new EvidenceLibrary(directory).open();
    assert.equal(healed.index.blobs[anyBlob], undefined);
    // 清单自身可读且结构完整。
    const stored = await library.readManifest();
    assert.equal(stored.schemaVersion, 1);
    assert.equal(stored.components.length, manifest.components.length);
    await rm(directory, { recursive: true, force: true });
  } finally { await source.close(); }
});

test('证据字节可按 sha256 取回且与清单一致', async () => {
  const source = await startFixture();
  try {
    const { directory, library, manifest } = await runCollect(source);
    const component = manifest.components.find(item => item.status === STATUS.COLLECTED);
    const licenseEvidence = component.evidence.find(item => item.kind === 'license');
    const bytes = await library.readBlob(licenseEvidence.sha256);
    assert.ok(bytes.toString('utf8').includes('许可证'));
    await assert.rejects(library.readBlob('../escape'), /证据标识无效/);
    await rm(directory, { recursive: true, force: true });
  } finally { await source.close(); }
});
