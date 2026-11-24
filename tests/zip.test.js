import test from 'node:test';
import assert from 'node:assert/strict';

import { readZip, writeZip, crc32 } from '../src/core/zip.js';

test('crc32 matches the reference implementation', () => {
  const data = new TextEncoder().encode('123456789');
  assert.equal(crc32(data), 0xcbf43926);
});

test('round-trips stored and deflated archives', async () => {
  const encoder = new TextEncoder();
  const entries = [
    { name: 'a.txt', data: encoder.encode('hello world') },
    { name: 'nested/b.bin', data: new Uint8Array(5000).map((_, i) => i % 251) },
    { name: 'unicode-\u00f1.txt', data: encoder.encode('ok') },
  ];
  for (const compress of [false, true]) {
    const archive = await writeZip(entries, { compress });
    const read = await readZip(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength));
    assert.equal(read.length, entries.length);
    for (let i = 0; i < entries.length; i++) {
      assert.equal(read[i].name, entries[i].name);
      assert.deepEqual([...read[i].data], [...entries[i].data]);
    }
  }
});

test('rejects non-zip buffers', async () => {
  await assert.rejects(() => readZip(new Uint8Array(64).buffer), /Not a ZIP archive/);
});
