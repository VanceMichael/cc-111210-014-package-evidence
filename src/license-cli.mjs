import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EvidenceLibrary } from './evidence-library.mjs';
import { collect } from './collector.mjs';
import { fetchLock } from './connector.mjs';

// 用法:
//   node src/license-cli.mjs --lock ./package-lock.json --base http://127.0.0.1:PORT --out ./output/licenses
//   node src/license-cli.mjs --base http://127.0.0.1:PORT --out ./output/licenses   (直接从镜像 /lock 领取)
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token.startsWith('--')) args[token.slice(2)] = argv[++index];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.base) throw new Error('需要 --base 指定授权镜像地址');
  if (!/^https?:\/\//.test(args.base)) throw new Error('--base 必须是 http(s) 地址');
  const out = resolve(args.out ?? join(process.cwd(), 'output', 'licenses'));
  const lock = await fetchLock(args.lock ?? args.base);

  const library = new EvidenceLibrary(out);
  const manifest = await collect(lock, library, {
    base: args.base.replace(/\/$/, ''),
    allowedHosts: args.allowHost ? args.allowHost.split(',') : [],
    loopbackOnly: args.loopbackOnly !== 'false',
  });
  console.log(JSON.stringify({ manifestPath: manifest.manifestPath, summary: manifest.summary }, null, 2));
  if (manifest.summary.failures > 0) process.exitCode = 2;
}

// 允许作为库调用时不触发执行。
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => { console.error(JSON.stringify({ error: error.message })); process.exit(1); });
}

export async function collectIntoTemp(lock, base, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'license-lib-'));
  const library = new EvidenceLibrary(directory);
  const manifest = await collect(lock, library, { base, ...options });
  return { directory, library, manifest };
}
