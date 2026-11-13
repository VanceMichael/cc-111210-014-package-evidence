// 最小 tar 解析器：只在内存中遍历归档条目，绝不写入文件系统、绝不执行任何脚本。
// 支持 ustar 常规文件、GNU long name(L)、POSIX pax 扩展头(x/g)与目录。
// gzip 外壳由调用方用 node:zlib 解出后传入原始 tar 字节。

function readString(buffer, offset, length) {
  let end = offset;
  const limit = offset + length;
  while (end < limit && buffer[end] !== 0) end++;
  return buffer.subarray(offset, end).toString('utf8');
}

function readOctal(buffer, offset, length) {
  const text = readString(buffer, offset, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error('tar 头部数字字段无法解析');
  return Number.parseInt(text, 8);
}

function validChecksum(header) {
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < 512; index++) {
    const byte = index >= 148 && index < 156 ? 32 : header[index];
    unsigned += byte;
    signed += index >= 148 && index < 156 ? 32 : (byte > 127 ? byte - 256 : byte);
  }
  const stored = Number.parseInt(readString(header, 148, 8).replace(/[^0-7]/g, ''), 8);
  return stored === unsigned || stored === signed;
}

// 应用 pax 扩展记录中的 path/linkpath 覆盖。
function applyPaxRecord(meta, record) {
  for (const line of record.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error('pax 扩展记录无法解析');
    const definition = line.slice(space + 1);
    const equal = definition.indexOf('=');
    if (equal < 0) throw new Error('pax 扩展记录无法解析');
    const keyword = definition.slice(0, equal);
    const value = definition.slice(equal + 1);
    if (keyword === 'path') meta.name = value;
    else if (keyword === 'linkpath') meta.linkname = value;
  }
}

export function readTarEntries(tarBytes, { maxEntries = 20000, maxEntryBytes = 64 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(tarBytes)) throw new Error('tar 数据必须是缓冲区');
  const entries = [];
  let offset = 0;
  let pendingName = null;
  let pendingLink = null;
  let count = 0;

  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);
    // 全零块即归档结束（规范要求连续两个零块，见到第一个即可终止）。
    if (header.every(byte => byte === 0)) break;
    if (!validChecksum(header)) throw new Error('tar 头部校验和不符');

    const typeFlag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const size = readOctal(header, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('tar 条目长度无效');
    if (size > maxEntryBytes) throw new Error('tar 条目超过大小上限');
    const blocks = Math.ceil(size / 512);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > tarBytes.length) throw new Error('tar 条目被截断');
    const content = tarBytes.subarray(contentStart, contentEnd);

    let name = readString(header, 0, 100);
    // ustar 头部布局：prefix 位于 345..500，257..262 是 magic 字段。
    const prefix = readString(header, 345, 155);
    if (prefix) name = prefix + '/' + name;
    const linkname = readString(header, 157, 100);
    const meta = { name, linkname, typeFlag, size, content, isFile: false };

    if (typeFlag === 'L') {
      // GNU long name：内容是以 NUL 结尾的下一条目名称。
      pendingName = content.subarray(0, content.indexOf(0) >= 0 ? content.indexOf(0) : content.length).toString('utf8');
    } else if (typeFlag === 'K') {
      pendingLink = content.toString('utf8').replace(/\0+$/, '');
    } else if (typeFlag === 'x' || typeFlag === 'g') {
      applyPaxRecord(meta, content.toString('utf8'));
      pendingName = meta.name !== name ? meta.name : pendingName;
      pendingLink = meta.linkname !== linkname ? meta.linkname : pendingLink;
    } else {
      if (pendingName) { meta.name = pendingName; pendingName = null; }
      if (pendingLink) { meta.linkname = pendingLink; pendingLink = null; }
      if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '7') meta.isFile = true;
      if (typeFlag === '5') meta.isFile = false;
      // 符号/硬链接(1/2)在 npm 包中不应出现；记录但不跟随，避免路径逃逸。
      entries.push(meta);
      if (++count > maxEntries) throw new Error('tar 条目数量超过上限');
    }
    offset = offset + 512 + blocks * 512;
  }
  return entries;
}
