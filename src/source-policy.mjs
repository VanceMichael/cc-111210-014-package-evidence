// 来源准入：锁文件中的 resolved 地址必须指向被授权的镜像主机。
// 可变的 dist-tag 不参与准入判断，准入对象只来自锁文件锁定的 tarball URL。

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function allowedSource(resolved, { allowedHosts = [], loopbackOnly = true } = {}) {
  let url;
  try {
    url = new URL(resolved);
  } catch {
    return { ok: false, reason: 'resolved 地址无法解析' };
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { ok: false, reason: `不允许的协议: ${url.protocol}` };
  }
  const host = url.hostname;
  if (loopbackOnly && !LOOPBACK.has(host)) {
    return { ok: false, reason: '演练模式只允许回环地址' };
  }
  if (allowedHosts.length > 0 && !allowedHosts.includes(host)) {
    return { ok: false, reason: `主机不在授权镜像清单: ${host}` };
  }
  return { ok: true, url };
}
