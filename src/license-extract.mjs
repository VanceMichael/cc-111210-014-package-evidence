import { readTarEntries } from './tar-reader.mjs';

// 去掉归档内统一的 package/ 前缀，得到包内相对路径，使用 posix 风格。
function packageRelative(name) {
  const normalized = name.replace(/^\.\//, '');
  const stripped = normalized.startsWith('package/') ? normalized.slice('package/'.length) : normalized;
  return stripped.replace(/^\/+/, '');
}

const LICENSE_PATTERN = /(^|\/)(licen[sc]e|licence)(\.[a-z0-9]+)?$/i;
const NOTICE_PATTERN = /(^|\/)notice(\.[a-z0-9]+)?$/i;
const COPYING_PATTERN = /(^|\/)copying(\.[a-z0-9]+)?$/i;

// 分类结果中许可证与 NOTICE 始终是不同资料；许可证可能位于任意嵌套目录。
export function classifyEntries(entries) {
  const licenses = [];
  const notices = [];
  let packageJsonEntry = null;
  for (const entry of entries) {
    if (!entry.isFile) continue;
    const relative = packageRelative(entry.name);
    if (relative === 'package.json' || relative === '') {
      if (relative === 'package.json') packageJsonEntry = entry;
    }
    if (NOTICE_PATTERN.test(relative)) {
      notices.push({ path: relative, bytes: entry.content });
    } else if (LICENSE_PATTERN.test(relative) || COPYING_PATTERN.test(relative)) {
      licenses.push({ path: relative, bytes: entry.content });
    }
  }
  return { licenses, notices, packageJsonEntry };
}

// 安全读取 package.json：它是不可信数据，只解析字段，绝不 require/import。
function readPackageJson(entry) {
  if (!entry) return null;
  try {
    const doc = JSON.parse(entry.content.toString('utf8'));
    return doc && typeof doc === 'object' ? doc : null;
  } catch {
    return null;
  }
}

// 从已校验 tar 字节（gzip 外壳）提取证据材料，全部留在内存。
export function extractEvidence(gzipBytes, gunzip) {
  const tarBytes = gunzip(gzipBytes);
  const entries = readTarEntries(tarBytes);
  const { licenses, notices, packageJsonEntry } = classifyEntries(entries);
  const packageJson = readPackageJson(packageJsonEntry);
  // 安装脚本仅作为元数据登记，用于证明“存在但未执行”，绝不调用。
  const lifecycleScripts = packageJson?.scripts
    ? Object.fromEntries(Object.entries(packageJson.scripts).filter(([name]) =>
        ['preinstall', 'install', 'postinstall', 'preuninstall', 'uninstall'].includes(name)))
    : {};
  return {
    entries: entries.map(({ name, typeFlag, size, isFile }) => ({ name, typeFlag, size, isFile })),
    licenses,
    notices,
    packageJson: packageJson ? {
      name: packageJson.name ?? null,
      version: packageJson.version ?? null,
      license: packageJson.license ?? packageJson.licenses ?? null,
    } : null,
    lifecycleScripts,
    packageJsonParseError: packageJsonEntry && !packageJson ? 'package.json 无法解析' : null,
  };
}
