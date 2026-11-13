import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from '../fixtures/source.mjs';
import { EvidenceLibrary } from './evidence-library.mjs';
import { collect } from './collector.mjs';
import { fetchLock } from './connector.mjs';

const directory = await mkdtemp(join(tmpdir(), 'license-demo-'));
const source = await startFixture();
try {
  const library = new EvidenceLibrary(directory);
  const lock = await fetchLock(source.url);

  console.log('=== 第一次领取：范围仅含锁文件指明的组件 ===');
  const first = await collect(lock, library, { base: source.url });
  for (const component of first.components) {
    const evidence = (component.evidence ?? []).map(item => `${item.kind}:${item.archivePath}#${item.sha256.slice(0, 12)}`);
    console.log(`- [${component.status}] ${component.id}${component.alias ? ' (npm alias)' : ''}${component.nested ? ' (嵌套)' : ''} -> ${component.detail}${evidence.length ? ' | ' + evidence.join(' ') : ''}`);
  }
  console.log('\n汇总:', JSON.stringify(first.summary, null, 2));

  console.log('\n=== 第二次领取：已校验字节不重新下载 ===');
  const downloadsBefore = source.requestCounts['/tar/fixture-lib-1.0.0.tgz'];
  const second = await collect(lock, library, { base: source.url });
  console.log(`归档下载次数保持 ${downloadsBefore}，本轮 downloads=${second.summary.downloads} cacheHits=${second.summary.cacheHits}`);

  console.log('\n=== 崩溃恢复：残留临时文件被清理，索引不指向悬空资料 ===');
  await writeFile(join(directory, 'blobs', 'crash.tmp'), 'partial');
  const healed = await new EvidenceLibrary(directory).open();
  const leftovers = (await readdir(directory)).filter(name => name.endsWith('.tmp'));
  console.log(`临时残留数量: ${leftovers.length}；索引对象 archives=${Object.keys(healed.index.archives).length} blobs=${Object.keys(healed.index.blobs).length}`);

  console.log('\n=== 资料库布局（内容寻址去重）===');
  console.log('目录:', directory);
  console.log('blobs:', await readdir(join(directory, 'blobs')));
  console.log('archives:', await readdir(join(directory, 'archives')));
  // 演示本身成功完成即退出 0；CLI 在清单含失败状态时退出 2，供交付流水线卡点。
} finally {
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
