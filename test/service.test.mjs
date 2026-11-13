import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReceiptStore } from '../src/store.mjs';
import { startService } from '../src/service.mjs';
import { startFixture } from '../fixtures/source.mjs';

test('接收记录支持同内容重复领取并拒绝覆盖', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'receipt-'));
  try {
    const store = new ReceiptStore(directory);
    assert.deepEqual(await store.save('one', { value: 3 }), await store.save('one', { value: 3 }));
    await assert.rejects(store.save('one', { value: 4 }), /冲突/);
    await assert.rejects(store.save('../escape', {}), /无效/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('服务健康检查和单次查看走真实来源', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'service-'));
  const fixture = await startFixture();
  const service = await startService({ source: fixture.url, directory });
  try {
    assert.equal((await (await fetch(service.url + '/health')).json()).state, 'ready');
    const response = await fetch(service.url + '/inspect');
    assert.equal(response.status, 200, await response.text());
    assert.equal((await fetch(service.url + '/missing')).status, 404);
  } finally { await service.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

test('领取接口产出清单与内容寻址证据，证据可回读', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'service-'));
  const fixture = await startFixture();
  const service = await startService({ source: fixture.url, directory });
  try {
    const collectResponse = await fetch(service.url + '/collect');
    const collectText = await collectResponse.text();
    assert.equal(collectResponse.status, 200, collectText);
    const result = JSON.parse(collectText);
    assert.ok(result.summary.total === 11);
    assert.ok(result.summary.byStatus['collected'] >= 4);
    const manifestResponse = await fetch(service.url + '/manifest');
    const manifest = await manifestResponse.json();
    const component = manifest.components.find(item => item.evidence?.length);
    const blob = component.evidence.find(item => item.kind === 'license');
    const evidenceResponse = await fetch(service.url + '/evidence/' + blob.sha256);
    assert.ok((await evidenceResponse.text()).includes('许可证'));
    // 再领一次不产生新下载。
    const before = fixture.requestCounts['/tar/fixture-lib-1.0.0.tgz'];
    await fetch(service.url + '/collect');
    assert.equal(fixture.requestCounts['/tar/fixture-lib-1.0.0.tgz'], before);
  } finally { await service.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});
