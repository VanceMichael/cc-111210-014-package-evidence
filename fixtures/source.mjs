import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { listen } from '../src/http.mjs';

function tarFile(name, body) {
  const data = Buffer.from(body);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write('ustar\0', 257);
  const sum = header.reduce((total, value) => total + value, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}

function makeArchive(files) {
  const blocks = files.map(([name, body]) => tarFile(name, body));
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

export const integrityOf = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');

// 1) fixture-lib 1.0.0：嵌套许可证 + NOTICE + 永不执行的安装脚本元数据。
export const archive = makeArchive([
  ['package/package.json', JSON.stringify({ name: 'fixture-lib', version: '1.0.0', license: 'MIT', scripts: { install: 'never-run' } })],
  ['package/docs/LICENSE', '合成许可证原文，仅供本地接入演练。'],
  ['package/NOTICE', '合成版权说明。'],
]);
export const integrity = integrityOf(archive);

// 2) fixture-lib 1.1.0：同名不同版本共存，根目录许可证。
export const archiveV11 = makeArchive([
  ['package/package.json', JSON.stringify({ name: 'fixture-lib', version: '1.1.0', license: 'MIT' })],
  ['package/LICENSE', 'fixture-lib 1.1.0 许可证原文（合成）。'],
]);
export const integrityV11 = integrityOf(archiveV11);

// 3) no-license-pkg：可信归档但完全没有许可证文件。
export const archiveNoLicense = makeArchive([
  ['package/package.json', JSON.stringify({ name: 'no-license-pkg', version: '1.0.0', license: 'UNLICENSED' })],
  ['package/README.md', '只有说明文档，没有许可证原文。'],
]);
export const integrityNoLicense = integrityOf(archiveNoLicense);

// 4) drift-pkg：字节正常，但镜像元数据 dist 摘要与锁文件约束冲突。
export const archiveDrift = makeArchive([
  ['package/package.json', JSON.stringify({ name: 'drift-pkg', version: '1.0.0' })],
  ['package/LICENSE', 'drift-pkg 许可证原文（合成）。'],
]);
export const integrityDrift = integrityOf(archiveDrift);

// 5) vanished：字节在镜像上不存在（404），但锁文件持有它的合法完整性约束。
export const archiveVanished = makeArchive([
  ['package/package.json', JSON.stringify({ name: 'vanished', version: '1.0.0' })],
  ['package/LICENSE', '永不被服务的许可证原文（合成）。'],
]);
export const integrityVanished = integrityOf(archiveVanished);

// 6) conflict-pkg：锁文件约束指向它自己的原始字节，镜像实际服务的是被污染字节。
export const archiveConflict = makeArchive([
  ['package/package.json', JSON.stringify({ name: 'conflict-pkg', version: '1.0.0', license: 'MIT' })],
  ['package/LICENSE', 'conflict-pkg 原始许可证（合成，镜像不会服务这一字节）。'],
]);
export const integrityConflict = integrityOf(archiveConflict);
export const archiveCorrupted = Buffer.concat([archiveConflict, Buffer.from([0x5a])]);

const archives = {
  'fixture-lib-1.0.0': { bytes: archive, integrity },
  'fixture-lib-1.1.0': { bytes: archiveV11, integrity: integrityV11 },
  'no-license-pkg-1.0.0': { bytes: archiveNoLicense, integrity: integrityNoLicense },
  'drift-pkg-1.0.0': { bytes: archiveDrift, integrity: integrityDrift },
  'conflict-pkg-1.0.0': { bytes: archiveCorrupted, integrity: integrityConflict },
};

// 故意构造的错误摘要，供冲突场景使用。
const wrongIntegrity = 'sha512-' + createHash('sha512').update('not-the-archive').digest('base64');

export async function startFixture() {
  let urlBase;
  const requestCounts = {};
  const count = pathname => { requestCounts[pathname] = (requestCounts[pathname] ?? 0) + 1; };

  const source = await listen(async url => {
    count(url.pathname);

    if (url.pathname === '/lock') {
      return {
        body: {
          name: 'offline-capture',
          lockfileVersion: 3,
          packages: {
            '': { name: 'offline-capture' },
            // 常规安装：嵌套许可证
            'node_modules/fixture-lib': { version: '1.0.0', resolved: `${urlBase}/tar/fixture-lib-1.0.0.tgz`, integrity },
            // npm alias：安装名 renamed，真实包名仍是 fixture-lib
            'node_modules/renamed': { name: 'fixture-lib', version: '1.0.0', resolved: `${urlBase}/tar/fixture-lib-1.0.0.tgz`, integrity },
            // 同名不同版本共存
            'node_modules/fixture-lib-1x': { name: 'fixture-lib', version: '1.1.0', resolved: `${urlBase}/tar/fixture-lib-1.1.0.tgz`, integrity: integrityV11 },
            // 嵌套安装路径
            'node_modules/host/node_modules/fixture-lib': { version: '1.0.0', resolved: `${urlBase}/tar/fixture-lib-1.0.0.tgz`, integrity },
            // 冲突摘要：锁文件约束合法，但镜像服务的归档字节被污染
            'node_modules/conflict-pkg': { version: '1.0.0', resolved: `${urlBase}/tar/conflict-pkg-1.0.0.tgz`, integrity: integrityConflict },
            // 缺许可证
            'node_modules/no-license-pkg': { version: '1.0.0', resolved: `${urlBase}/tar/no-license-pkg-1.0.0.tgz`, integrity: integrityNoLicense },
            // 元数据 dist 摘要冲突（锁文件约束与字节一致，但元数据漂移）
            'node_modules/drift-pkg': { version: '1.0.0', resolved: `${urlBase}/tar/drift-pkg-1.0.0.tgz`, integrity: integrityDrift },
            // 来源不允许：非回环主机
            'node_modules/denied-pkg': { version: '1.0.0', resolved: 'https://registry.example.net/denied-pkg-1.0.0.tgz', integrity },
            // 无法解析：完整性约束损坏，且 tarball 与元数据均不存在
            'node_modules/unresolved-pkg': { version: '9.9.9', resolved: `${urlBase}/tar/missing-9.9.9.tgz`, integrity: 'sha512-@@@not-base64@@@' },
            // 领取失败：约束合法但镜像上归档不存在（404，字节不登记到 archives 路由）
            'node_modules/missing-tarball': { version: '1.0.0', resolved: `${urlBase}/tar/vanished-1.0.0.tgz`, integrity: integrityVanished },
            // workspace 本地链接
            'node_modules/local': { link: true, resolved: 'packages/local' },
          },
        },
      };
    }

    // 兼容旧入口：registry 风格聚合索引
    if (url.pathname === '/metadata') {
      const docs = buildMetadata(urlBase);
      return { body: aggregateIndex(docs) };
    }
    if (url.pathname.startsWith('/pkg-metadata/')) {
      const name = decodeURIComponent(url.pathname.slice('/pkg-metadata/'.length));
      const doc = buildMetadata(urlBase)[name];
      if (!doc) return { status: 404, body: { error: '元数据不存在' } };
      return { body: doc };
    }

    if (url.pathname.startsWith('/tar/')) {
      const key = url.pathname.slice('/tar/'.length).replace('.tgz', '');
      const item = archives[key];
      if (!item) return { status: 404, body: { error: '归档不存在' } };
      return { type: 'application/gzip', body: item.bytes };
    }

    // 兼容旧路径
    if (url.pathname === '/package.tgz') return { type: 'application/gzip', body: archive };
    if (url.pathname === '/corrupt.tgz') return { type: 'application/gzip', body: Buffer.concat([archive, Buffer.from([1])]) };

    if (url.pathname === '/stats') return { body: { requestCounts } };
    return { status: 404, body: {} };
  });

  urlBase = source.url;
  source.requestCounts = requestCounts;
  return source;
}

// 可变 dist-tag 故意指向另一个版本；领取逻辑必须无视它，只按锁文件版本取 dist。
function buildMetadata(base) {
  return {
    'fixture-lib': {
      name: 'fixture-lib',
      'dist-tags': { latest: '2.0.0' },
      versions: {
        '1.0.0': { name: 'fixture-lib', version: '1.0.0', dist: { tarball: `${base}/tar/fixture-lib-1.0.0.tgz`, integrity } },
        '1.1.0': { name: 'fixture-lib', version: '1.1.0', dist: { tarball: `${base}/tar/fixture-lib-1.1.0.tgz`, integrity: integrityV11 } },
      },
    },
    'no-license-pkg': {
      name: 'no-license-pkg',
      'dist-tags': { latest: '1.0.0' },
      versions: {
        '1.0.0': { name: 'no-license-pkg', version: '1.0.0', dist: { tarball: `${base}/tar/no-license-pkg-1.0.0.tgz`, integrity: integrityNoLicense } },
      },
    },
    // 元数据中的摘要被篡改，与锁文件约束（及真实字节）冲突。
    'drift-pkg': {
      name: 'drift-pkg',
      'dist-tags': { latest: '1.0.0' },
      versions: {
        '1.0.0': { name: 'drift-pkg', version: '1.0.0', dist: { tarball: `${base}/tar/drift-pkg-1.0.0.tgz`, integrity: wrongIntegrity } },
      },
    },
  };
}

// 旧版 inspect 使用的聚合视图：合并各包版本段，dist-tag 保留首次出现（fixture-lib 的 latest=2.0.0）。
function aggregateIndex(docs) {
  const distTags = {};
  const versions = {};
  for (const doc of Object.values(docs)) {
    for (const [tag, value] of Object.entries(doc['dist-tags'])) {
      if (!(tag in distTags)) distTags[tag] = value;
    }
    Object.assign(versions, doc.versions);
  }
  return { 'dist-tags': distTags, versions };
}
