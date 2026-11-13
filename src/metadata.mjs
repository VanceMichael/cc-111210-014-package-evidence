import { get } from './http.mjs';

// 只读取锁文件指定的 name@version 对应的元数据版本段。
// dist-tags（如 latest 漂移）绝不参与版本选择，仅记录其漂移事实供审计。
export async function pinnedMetadata(base, name, version) {
  const response = await get(base, `/pkg-metadata/${encodeURIComponent(name).replace('%40', '@')}`);
  const document_ = await response.json();
  const tags = document_['dist-tags'] ?? {};
  const release = document_.versions?.[version];
  return {
    tags,
    tagDrift: tags.latest && tags.latest !== version ? { latest: tags.latest, pinned: version } : null,
    release: release ?? null,
  };
}

// 核对锁文件约束、镜像元数据 dist 摘要与 tarball 地址三者的一致性。
export function crossCheck({ entry, release }) {
  const problems = [];
  if (!release) return { ok: false, problems: ['镜像元数据缺少锁定版本'] };
  if (!release.dist) { problems.push('元数据缺少 dist 段'); return { ok: false, problems }; }
  if (release.dist.integrity && release.dist.integrity !== entry.integrity) {
    problems.push('元数据 dist 摘要与锁文件约束不符');
  }
  if (release.dist.tarball && entry.resolved && new URL(release.dist.tarball).href !== new URL(entry.resolved).href) {
    problems.push('元数据 tarball 地址与锁文件 resolved 不符');
  }
  return { ok: problems.length === 0, problems };
}
