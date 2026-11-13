import { listen, get } from './http.mjs';
import { inspect } from './connector.mjs';
import { ReceiptStore } from './store.mjs';
import { EvidenceLibrary } from './evidence-library.mjs';
import { collect } from './collector.mjs';

export async function startService({ source, directory, port = 0 }) {
  const store = new ReceiptStore(directory);
  const library = new EvidenceLibrary(directory + '/evidence');
  await library.open();
  return listen(async url => {
    if (url.pathname === '/health') return { body: { state: 'ready' } };
    if (url.pathname === '/inspect') {
      const result = await inspect(source, Object.fromEntries(url.searchParams));
      return { body: result };
    }
    if (url.pathname === '/receive') {
      const key = url.searchParams.get('key') ?? 'single';
      const result = await inspect(source, Object.fromEntries(url.searchParams));
      return { body: await store.save(key, result) };
    }
    if (url.pathname.startsWith('/receipts/')) return { body: await store.read(url.pathname.split('/').pop()) };

    // 按锁文件范围领取许可证证据；不接受任意包名，不做依赖升级。
    if (url.pathname === '/collect') {
      const lock = await (await get(source, '/lock')).json();
      const manifest = await collect(lock, library, { base: source });
      return { body: { manifestPath: manifest.manifestPath, summary: manifest.summary } };
    }
    if (url.pathname === '/manifest') return { body: await library.readManifest() };
    if (url.pathname.startsWith('/evidence/')) {
      const key = url.pathname.split('/').pop();
      const bytes = await library.readBlob(key);
      return { type: 'application/octet-stream', body: bytes };
    }
    return { status: 404, body: { error: '接口不存在' } };
  }, port);
}
