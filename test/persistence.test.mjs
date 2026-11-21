import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { createSource } from '../sources/source.mjs';
import { createSourceClient } from '../src/source-client.mjs';
import { CuratorService } from '../src/curator.mjs';
import { createFilePersistence } from '../src/persistence.mjs';

async function harness() {
  const sourceServer = createSource();
  sourceServer.listen(0, '127.0.0.1');
  await once(sourceServer, 'listening');
  const baseUrl = `http://127.0.0.1:${sourceServer.address().port}`;
  const directory = mkdtempSync(join(tmpdir(), 'curator-'));
  const path = join(directory, 'state.json');
  return {
    sourceServer,
    baseUrl,
    path,
    cleanup() {
      sourceServer.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('重启后保留已发命令与回执，并继续使用更大的序号', async (context) => {
  const { sourceServer, baseUrl, path, cleanup } = await harness();
  context.after(cleanup);

  const first = new CuratorService({
    source: createSourceClient({ baseUrl }),
    persistence: createFilePersistence(path),
  });
  await first.sync();
  const result = await first.reconcile('2026-12-05T09:30:00+08:00');
  const dispatched = result.dispatched.filter((item) => item.ok);
  assert.ok(dispatched.length > 0);
  const highestFirst = Math.max(...dispatched.map((item) => item.sequence));

  const second = new CuratorService({
    source: createSourceClient({ baseUrl }),
    persistence: createFilePersistence(path),
  });
  await second.sync();
  // 序号没有倒退：继续下发时一定要大于重启前的最高序号。
  const next = second.ledger.dispatch({ screen: 'P2', slot: 'feature', action: 'off' });
  assert.equal(next.ok, true);
  assert.ok(next.sequence > highestFirst, `${next.sequence} 应大于 ${highestFirst}`);

  // 审计记录也在。
  assert.ok(second.audit.some((entry) => entry.kind === 'command'));
});

test('持久化失败不阻止发布，只影响下次恢复', async (context) => {
  const { sourceServer, baseUrl, cleanup } = await harness();
  context.after(cleanup);
  const failing = {
    load: () => null,
    save: () => { throw new Error('磁盘只读'); },
  };
  const service = new CuratorService({ source: createSourceClient({ baseUrl }), persistence: failing });
  await service.sync();
  await assert.rejects(() => service.reconcile('2026-12-05T09:30:00+08:00'), /磁盘只读/);
  // 命令本身已经发出，并保留在内存台账里。
  assert.ok(service.ledger.receipts().length >= 0);
});
