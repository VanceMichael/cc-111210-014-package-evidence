import { createHash, timingSafeEqual } from 'node:crypto';

// 解析 npm lockfile 的 SRI 完整性约束，例如 sha512-xxxx== 。
// 一个约束可含多个算法段；同算法出现多次时全部保留，校验需全部通过。
export function parseIntegrity(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('完整性约束缺失');
  const parts = value.trim().split(/\s+/).map(segment => {
    const dash = segment.indexOf('-');
    if (dash <= 0) throw new Error('完整性约束无法解析');
    const algorithm = segment.slice(0, dash).toLowerCase();
    const digestBase64 = segment.slice(dash + 1);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(digestBase64) || digestBase64.length === 0) {
      throw new Error('完整性约束无法解析');
    }
    const mapping = { sha256: 'sha256', sha384: 'sha384', sha512: 'sha512', sha1: 'sha1' };
    if (!mapping[algorithm]) throw new Error(`不支持的完整性算法: ${algorithm}`);
    let expected;
    try { expected = Buffer.from(digestBase64, 'base64'); } catch { throw new Error('完整性约束无法解析'); }
    if (expected.toString('base64') !== digestBase64) throw new Error('完整性约束无法解析');
    return { algorithm: mapping[algorithm], expected, raw: segment };
  });
  if (parts.length === 0) throw new Error('完整性约束无法解析');
  return parts;
}

// 用完整性约束核对实际字节，常量时间比较，任一段不符即拒绝。
export function verifyIntegrity(bytes, constraints) {
  const checked = [];
  for (const { algorithm, expected } of constraints) {
    const actual = createHash(algorithm).update(bytes).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return { ok: false, algorithm, checked };
    }
    checked.push(algorithm);
  }
  return { ok: true, checked };
}

// 为已校验字节生成确定性的归档标识：优先强度最高的算法，URL 安全 base64。
export function archiveKey(bytes, constraints) {
  const preference = ['sha512', 'sha384', 'sha256', 'sha1'];
  const algorithm = preference.find(name => constraints.some(part => part.algorithm === name)) ?? 'sha512';
  return algorithm + '-' + createHash(algorithm).update(bytes).digest('base64url');
}

// 仅为输出摘要使用的十六进制指纹。
export function fingerprint(bytes, algorithm = 'sha512') {
  return createHash(algorithm).update(bytes).digest('hex');
}
