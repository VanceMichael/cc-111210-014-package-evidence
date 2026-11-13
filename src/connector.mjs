import { get } from './http.mjs';
import { parseIntegrity } from './integrity.mjs';

// 从锁文件安装路径还原“安装名”与嵌套层级，例如：
// node_modules/a/node_modules/b  ->  顶层 a 的嵌套依赖 b
function pathIdentity(lockPath) {
  const segments = lockPath.split('/').filter(Boolean);
  const depth = segments.filter(segment => segment === 'node_modules').length;
  const installedName = segments[segments.length - 1];
  return { installedName, depth };
}

// 校验锁文件自身的完整性约束字段，无法解析的引用直接显式标记，不静默跳过。
function checkConstraint(entry) {
  if (entry.link) return { constraintOk: true, integrityError: null };
  if (!entry.integrity) return { constraintOk: false, integrityError: '缺少 integrity 约束' };
  try {
    parseIntegrity(entry.integrity);
    return { constraintOk: true, integrityError: null };
  } catch (error) {
    return { constraintOk: false, integrityError: error.message };
  }
}

export function lockedPackages(lock) {
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') {
    throw new Error('锁文件版本无效');
  }
  return Object.entries(lock.packages)
    .filter(([lockPath]) => lockPath.startsWith('node_modules/'))
    .map(([lockPath, item]) => {
      const { installedName, depth } = pathIdentity(lockPath);
      const realName = item.name ?? installedName;
      const { constraintOk, integrityError } = checkConstraint(item);
      return {
        path: lockPath,
        installedName,
        name: realName,
        version: item.version ?? null,
        resolved: item.resolved ?? null,
        integrity: item.integrity ?? null,
        link: item.link ?? false,
        alias: Boolean(item.name && item.name !== installedName),
        nested: depth > 1,
        constraintOk,
        integrityError,
      };
    });
}

// 组件身份键：同名不同版本、别名、嵌套安装各自独立。
export function componentId(entry) {
  return entry.link
    ? `link:${entry.path}`
    : `${entry.name}@${entry.version ?? 'unknown'}${entry.alias ? `<-${entry.installedName}` : ''}${entry.nested ? `@${entry.path}` : ''}`;
}

export async function fetchLock(baseOrUrl) {
  if (/^https?:\/\//.test(baseOrUrl)) return (await get(baseOrUrl, '/lock')).json();
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(baseOrUrl, 'utf8'));
}

export async function inspect(base) {
  const lock = await (await get(base, '/lock')).json();
  const packages = lockedPackages(lock);
  return { packages, metadata: await (await get(base, '/metadata')).json() };
}
