import { gunzipSync } from 'node:zlib';
import { parseIntegrity, verifyIntegrity, fingerprint } from './integrity.mjs';
import { allowedSource } from './source-policy.mjs';
import { pinnedMetadata, crossCheck } from './metadata.mjs';
import { extractEvidence } from './license-extract.mjs';
import { lockedPackages, componentId } from './connector.mjs';
import { get, getUrl } from './http.mjs';

// 明确状态集合：
// collected       已领取到许可证原文并入库
// missing-license 归档可信但找不到任何许可证文件
// digest-mismatch 锁文件约束、元数据摘要或实际归档字节核对失败
// source-denied   来源不在授权镜像范围
// unresolved      引用无法解析（约束损坏、版本缺失、地址无效等）
// workspace-link  本地 workspace 软链，不产生外部领取
// fetch-failed    授权来源请求失败（404/网络/超时等）
export const STATUS = {
  COLLECTED: 'collected',
  MISSING_LICENSE: 'missing-license',
  DIGEST_MISMATCH: 'digest-mismatch',
  SOURCE_DENIED: 'source-denied',
  UNRESOLVED: 'unresolved',
  WORKSPACE_LINK: 'workspace-link',
  FETCH_FAILED: 'fetch-failed',
};

const TERMINAL_FAILURES = new Set([
  STATUS.DIGEST_MISMATCH, STATUS.SOURCE_DENIED, STATUS.UNRESOLVED, STATUS.FETCH_FAILED,
]);

async function downloadTarball(url) {
  const response = await getUrl(url);
  return Buffer.from(await response.arrayBuffer());
}

// 单个组件的完整领取流程，任何异常都被收敛为显式状态，不影响其他组件。
async function collectOne(entry, base, library, options, counters) {
  const id = componentId(entry);
  const baseRecord = {
    id,
    lockPath: entry.path,
    name: entry.name,
    installedName: entry.installedName,
    version: entry.version,
    alias: entry.alias,
    nested: entry.nested,
    resolved: entry.resolved,
    integrity: entry.integrity,
  };

  if (entry.link) {
    return { ...baseRecord, status: STATUS.WORKSPACE_LINK, detail: `本地链接: ${entry.resolved ?? entry.path}`, evidence: [] };
  }
  if (!entry.constraintOk) {
    return { ...baseRecord, status: STATUS.UNRESOLVED, detail: entry.integrityError, evidence: [] };
  }
  if (!entry.version || !entry.resolved) {
    return { ...baseRecord, status: STATUS.UNRESOLVED, detail: '锁条目缺少 version 或 resolved', evidence: [] };
  }

  const policy = allowedSource(entry.resolved, options);
  if (!policy.ok) {
    return { ...baseRecord, status: STATUS.SOURCE_DENIED, detail: policy.reason, evidence: [] };
  }

  // 第一步：镜像元数据，只取锁定版本；dist-tag 漂移不改变领取对象。
  // 元数据暂时不可读不致命——锁文件完整性约束与实际字节核对仍是硬门槛。
  let metadataView = null;
  let metadataUnavailable = null;
  try {
    metadataView = await pinnedMetadata(base, entry.name, entry.version);
  } catch (error) {
    metadataUnavailable = error.message;
  }
  const check = metadataView ? crossCheck({ entry, release: metadataView.release }) : { ok: false, problems: [] };
  const metadataProblems = check.problems;

  // 第二步：解析完整性约束并查本地已校验缓存，命中则不产生任何下载。
  let constraints;
  try {
    constraints = parseIntegrity(entry.integrity);
  } catch (error) {
    return { ...baseRecord, status: STATUS.UNRESOLVED, detail: error.message, evidence: [] };
  }
  // 缓存键完全由锁文件完整性约束推导：同字节同约束只下载一次，与可变标签无关。
  const cacheKey = constraints.map(({ algorithm, expected }) => `${algorithm}-${expected.toString('base64url')}`).join('~');

  let bytes = await library.cachedArchive(cacheKey);
  let downloaded = false;
  if (bytes) {
    counters.cacheHits++;
    // 缓存命中也要重新核对约束：同约束对应不同 resolved 地址时不得盲信缓存。
    const recheck = verifyIntegrity(bytes, constraints);
    if (!recheck.ok) {
      return { ...baseRecord, status: STATUS.DIGEST_MISMATCH, detail: `缓存归档与锁文件 ${recheck.algorithm} 摘要不符`, evidence: [] };
    }
  } else {
    const priorRejection = library.rejection(cacheKey);
    if (priorRejection) {
      counters.cacheHits++;
      return { ...baseRecord, status: STATUS.DIGEST_MISMATCH, detail: `归档字节与锁文件摘要不符（负缓存命中: ${priorRejection.detail}）`, evidence: [] };
    }
    try {
      bytes = await downloadTarball(entry.resolved);
      downloaded = true;
      counters.downloads++;
    } catch (error) {
      return { ...baseRecord, status: STATUS.FETCH_FAILED, detail: `归档下载失败: ${error.message}`, evidence: [] };
    }
    // 第三步：实际归档字节与锁文件完整性约束核对。
    const verify = verifyIntegrity(bytes, constraints);
    if (!verify.ok) {
      await library.saveRejection(cacheKey, `${verify.algorithm} 摘要不符`, entry.resolved);
      return { ...baseRecord, status: STATUS.DIGEST_MISMATCH, detail: `归档字节与锁文件 ${verify.algorithm} 摘要不符`, evidence: [] };
    }
    await library.saveArchive(cacheKey, bytes, entry.resolved);
  }

  // 元数据 dist 摘要冲突属于硬失败：字节已校验留存为审计样本，但不产出许可证证据。
  if (metadataProblems.length > 0) {
    return {
      ...baseRecord,
      status: STATUS.DIGEST_MISMATCH,
      detail: metadataProblems.join('; '),
      metadata: { tagDrift: metadataView?.tagDrift ?? null },
      archive: { sha512: fingerprint(bytes), bytes: bytes.length, downloaded, reused: !downloaded },
      evidence: [],
    };
  }

  // 第四步：内存解包分类，不落地解压、不执行安装脚本。
  let extracted;
  try {
    extracted = extractEvidence(bytes, gunzipSync);
  } catch (error) {
    return { ...baseRecord, status: STATUS.UNRESOLVED, detail: `归档无法解析: ${error.message}`, evidence: [] };
  }

  const evidence = [];
  for (const item of [...extracted.licenses.map(value => ({ ...value, kind: 'license' })),
                       ...extracted.notices.map(value => ({ ...value, kind: 'notice' }))]) {
    const saved = await library.saveBlob(item.bytes, item.kind);
    evidence.push({
      kind: item.kind,
      archivePath: item.path,
      sha256: saved.key,
      reused: saved.reused,
      bytes: item.bytes.length,
    });
  }

  const status = extracted.licenses.length === 0 ? STATUS.MISSING_LICENSE : STATUS.COLLECTED;
  return {
    ...baseRecord,
    status,
    detail: (metadataUnavailable ? `元数据不可读(${metadataUnavailable})；` : '')
      + (status === STATUS.MISSING_LICENSE ? '归档内未发现许可证原文文件' : `许可证 ${extracted.licenses.length} 份，NOTICE ${extracted.notices.length} 份`),
    metadata: { tagDrift: metadataView?.tagDrift ?? null, unavailable: metadataUnavailable },
    archive: { sha512: fingerprint(bytes), bytes: bytes.length, downloaded, reused: !downloaded },
    packageJson: extracted.packageJson,
    lifecycleScripts: extracted.lifecycleScripts,
    scriptsExecuted: false,
    tarEntries: extracted.entries.length,
    evidence,
  };
}

export async function collect(lock, library, options = {}) {
  await library.open();
  const entries = lockedPackages(lock);
  const counters = { downloads: 0, cacheHits: 0 };
  const components = [];
  for (const entry of entries) {
    components.push(await collectOne(entry, options.base, library, options, counters));
  }

  const summary = {
    total: components.length,
    byStatus: Object.fromEntries(Object.values(STATUS).map(status =>
      [status, components.filter(component => component.status === status).length])),
    failures: components.filter(component => TERMINAL_FAILURES.has(component.status)).length,
    downloads: counters.downloads,
    cacheHits: counters.cacheHits,
    library: library.stats(),
  };
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: options.base,
    lockName: lock.name ?? null,
    mutableTagsObserved: components
      .map(component => component.metadata?.tagDrift)
      .filter(Boolean),
    summary,
    components,
  };
  // 清单最后写入：引用的 blob/archive 均已先落盘并在索引中登记。
  manifest.manifestPath = await library.writeManifest(manifest);
  return manifest;
}
