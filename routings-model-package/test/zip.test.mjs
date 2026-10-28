import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { crc32, deflateRawSync } from 'node:zlib';
import { openZip, writeZip } from '../lib/zip.mjs';

// An independent fixture constructor intentionally permits invalid metadata.
// Production readers/writers have no switch that disables their validation.
function fixture(entries, { zip64Count = false, disk = 0 } = {}) {
  const localParts = [], centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0), method = entry.method ?? 0;
    const payload = entry.payload ?? (method === 8 ? deflateRawSync(data) : data);
    const flags = entry.flags ?? (entry.descriptor ? 8 : 0);
    const bytes = entry.bytes ?? data.length, checksum = entry.crc32 ?? crc32(data);
    const localName = Buffer.from(entry.localName ?? entry.name), centralName = Buffer.from(entry.name);
    const local64 = entry.zip64Entry ? Buffer.alloc(20) : Buffer.alloc(0);
    if (entry.zip64Entry) {
      local64.writeUInt16LE(1, 0); local64.writeUInt16LE(16, 2);
      local64.writeBigUInt64LE(BigInt(bytes), 4); local64.writeBigUInt64LE(BigInt(payload.length), 12);
    }
    const localExtra = entry.localExtra ?? local64;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(entry.zip64Entry ? 45 : 20, 4);
    local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(flags & 8 ? 0 : checksum, 14);
    local.writeUInt32LE(entry.zip64Entry ? 0xffffffff : (flags & 8 ? 0 : payload.length), 18);
    local.writeUInt32LE(entry.zip64Entry ? 0xffffffff : (flags & 8 ? 0 : bytes), 22);
    local.writeUInt16LE(localName.length, 26); local.writeUInt16LE(localExtra.length, 28);
    let descriptor = Buffer.alloc(0);
    if (flags & 8) {
      descriptor = Buffer.alloc(entry.zip64Entry ? 24 : 16);
      descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(entry.descriptorCrc ?? checksum, 4);
      if (entry.zip64Entry) {
        descriptor.writeBigUInt64LE(BigInt(payload.length), 8); descriptor.writeBigUInt64LE(BigInt(bytes), 16);
      } else { descriptor.writeUInt32LE(payload.length, 8); descriptor.writeUInt32LE(bytes, 12); }
    }
    const central64 = entry.zip64Entry ? Buffer.alloc(28) : Buffer.alloc(0);
    if (entry.zip64Entry) {
      central64.writeUInt16LE(1, 0); central64.writeUInt16LE(24, 2);
      central64.writeBigUInt64LE(BigInt(bytes), 4); central64.writeBigUInt64LE(BigInt(payload.length), 12);
      central64.writeBigUInt64LE(BigInt(offset), 20);
    }
    const extra = entry.extra ?? central64, central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(entry.zip64Entry ? 45 : 20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.zip64Entry ? 0xffffffff : payload.length, 20); central.writeUInt32LE(entry.zip64Entry ? 0xffffffff : bytes, 24);
    central.writeUInt16LE(centralName.length, 28); central.writeUInt16LE(extra.length, 30);
    const directory = entry.name.endsWith('/');
    central.writeUInt32LE(entry.attrs ?? (((directory ? 0o040755 : 0o100644) << 16) | (directory ? 0x10 : 0x20)) >>> 0, 38);
    central.writeUInt32LE(entry.zip64Entry ? 0xffffffff : (entry.offset ?? offset), 42);
    const padding = entry.padding ?? Buffer.alloc(0);
    localParts.push(local, localName, localExtra, payload, descriptor, padding);
    centralParts.push(central, centralName, extra);
    offset += local.length + localName.length + localExtra.length + payload.length + descriptor.length + padding.length;
  }
  const local = Buffer.concat(localParts), central = Buffer.concat(centralParts), endings = [];
  if (zip64Count) {
    const end64 = Buffer.alloc(56), locator = Buffer.alloc(20);
    end64.writeUInt32LE(0x06064b50, 0); end64.writeBigUInt64LE(44n, 4);
    end64.writeUInt16LE(45, 12); end64.writeUInt16LE(45, 14);
    end64.writeBigUInt64LE(BigInt(entries.length), 24); end64.writeBigUInt64LE(BigInt(entries.length), 32);
    end64.writeBigUInt64LE(BigInt(central.length), 40); end64.writeBigUInt64LE(BigInt(local.length), 48);
    locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(local.length + central.length), 8); locator.writeUInt32LE(1, 16);
    endings.push(end64, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(disk, 4);
  end.writeUInt16LE(zip64Count ? 0xffff : entries.length, 8); end.writeUInt16LE(zip64Count ? 0xffff : entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, ...endings, end]);
}
async function temp(t) {
  const base = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(base, 'routings-zip-test-'));
  // Only this newly allocated, verified direct child of the temp directory is
  // recursively removed; no input/model/workspace directory is involved.
  assert.equal(path.dirname(path.resolve(directory)), base);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
const hasCode = code => error => error?.code === code;

test('stored and deflated data, descriptors and empty SVF directories round-trip', async () => {
  const bytes = Buffer.from('A repeated model data string. '.repeat(150));
  const zip = await openZip(fixture([
    { name: 'scene/', flags: 0x0802 }, { name: 'geometry/' }, { name: 'material/', padding: Buffer.alloc(43) },
    { name: 'manifest.json', data: Buffer.from('{}') },
    { name: 'stored.bin', data: bytes }, { name: 'deflated.bin', data: bytes, method: 8, descriptor: true },
  ]));
  try {
    assert.equal(zip.entries.size, 6); assert.equal(zip.entries.get('scene/').isDirectory, true);
    assert.deepEqual(await zip.read('stored.bin'), bytes); assert.deepEqual(await zip.read('deflated.bin'), bytes);
    assert.deepEqual(await zip.read('material/'), Buffer.alloc(0));
  } finally { await zip.close(); }
});

test('empty deflated directory payloads are eagerly validated and accepted', async () => {
  const zip = await openZip(fixture([{ name: 'material/', method: 8, data: Buffer.alloc(0) }]));
  try {
    assert.equal(zip.entries.get('material/').bytes, 0);
    assert.deepEqual(await zip.read('material/', { maxBytes: 0 }), Buffer.alloc(0));
  } finally { await zip.close(); }
});

test('a directory cannot hide inflated bytes behind zero size/CRC metadata', async () => {
  await assert.rejects(openZip(fixture([{ name: 'material/', method: 8,
    data: Buffer.from('hidden directory data'), bytes: 0, crc32: 0 }])), hasCode('PACKAGE_LIMIT_EXCEEDED'));
});

test('corrupt deflated directory data is rejected before the archive is exposed', async () => {
  await assert.rejects(openZip(fixture([{ name: 'material/', method: 8,
    payload: Buffer.from([255, 255, 255]), bytes: 0, crc32: 0 }])), hasCode('INVALID_MANIFEST'));
});

test('streaming writer preserves local bytes and deterministic stored ZIP metadata', async t => {
  const directory = await temp(t), input = path.join(directory, 'input.bin');
  const data = Buffer.alloc(2 * 1024 * 1024, 0x5a); await fs.writeFile(input, data);
  const entries = [{ name: 'manifest.json', data: Buffer.from('{}') }, { name: 'resources/' , data: Buffer.alloc(0) }, { name: 'resources/output.bin', path: input }];
  const first = path.join(directory, 'first.zip'), second = path.join(directory, 'second.zip');
  const stats = await writeZip(first, entries); await writeZip(second, entries);
  assert.equal(stats.totalResourceBytes, data.length); assert.equal(stats.entries, 3);
  assert.deepEqual(await fs.readFile(first), await fs.readFile(second));
  const zip = await openZip(first);
  try { assert.deepEqual(await zip.read('resources/output.bin'), data); } finally { await zip.close(); }
  assert.deepEqual(await fs.readFile(input), data);
});

test('root manifest is separate from resource count/total and repeated reads do not double-charge', async () => {
  const zip = await openZip(fixture([
    { name: 'manifest.json', data: Buffer.from('more than four bytes') },
    { name: 'resources/' }, { name: 'resources/a', data: Buffer.from('data') },
  ]), { limits: { maxFiles: 1, maxTotalResourceBytes: 4 } });
  try {
    assert.equal((await zip.read('manifest.json')).length, 20);
    for (let index = 0; index < 3; index++) assert.equal((await zip.read('resources/a')).toString(), 'data');
  } finally { await zip.close(); }
});

test('ZIP64 entry offsets/sizes and ZIP64 descriptors are supported', async () => {
  const zip = await openZip(fixture([{ name: 'a', data: Buffer.from('zip64'), zip64Entry: true, descriptor: true }], { zip64Count: true }));
  try { assert.equal((await zip.read('a')).toString(), 'zip64'); } finally { await zip.close(); }
});

test('ZIP64 central-directory entry counts beyond 65535 are supported', async () => {
  const count = 65536;
  const zip = await openZip(fixture(Array.from({ length: count }, (_, index) => ({ name: `a${index}` })), { zip64Count: true }));
  try { assert.equal(zip.entries.size, count); assert.equal((await zip.read('a65535')).length, 0); } finally { await zip.close(); }
});

test('writer ZIP64 count footer is accepted by the reader', async t => {
  const directory = await temp(t), target = path.join(directory, 'zip64.zip');
  const entries = Array.from({ length: 65536 }, (_, index) => ({ name: `a${index}`, data: Buffer.alloc(0) }));
  const stats = await writeZip(target, entries); assert.equal(stats.zip64, true);
  const zip = await openZip(target);
  try { assert.equal(zip.entries.size, entries.length); assert.equal((await zip.read('a65535')).length, 0); } finally { await zip.close(); }
});

test('CRC corruption is detected during actual streamed reading', async () => {
  const archive = fixture([{ name: 'a', data: Buffer.from('good') }]); archive[31] ^= 1;
  const zip = await openZip(archive);
  try { await assert.rejects(zip.read('a'), hasCode('RESOURCE_HASH_MISMATCH')); } finally { await zip.close(); }
});

test('actual deflate inflation is bounded despite lying metadata', async () => {
  const zip = await openZip(fixture([{ name: 'a', data: Buffer.alloc(5000, 65), bytes: 10, method: 8 }]), { limits: { maxFileBytes: 128 } });
  try { await assert.rejects(zip.read('a', { maxBytes: 128 }), hasCode('PACKAGE_LIMIT_EXCEEDED')); } finally { await zip.close(); }
});

test('actual expansion ratio is bounded despite lying metadata', async () => {
  const zip = await openZip(fixture([{ name: 'a', data: Buffer.alloc(5000, 65), bytes: 10, method: 8 }]), { limits: { maxExpansionRatio: 2 } });
  try { await assert.rejects(zip.read('a'), hasCode('PACKAGE_LIMIT_EXCEEDED')); } finally { await zip.close(); }
});

test('decompression errors are reported as package errors', async () => {
  const zip = await openZip(fixture([{ name: 'a', data: Buffer.from('hello'), payload: Buffer.from([255, 255, 255]), method: 8 }]));
  try { await assert.rejects(zip.read('a'), hasCode('INVALID_MANIFEST')); } finally { await zip.close(); }
});

test('trailing bytes inside a deflate payload are rejected', async () => {
  const data = Buffer.from('hello'), payload = Buffer.concat([deflateRawSync(data), Buffer.from('hidden')]);
  const zip = await openZip(fixture([{ name: 'a', data, payload, method: 8 }]));
  try { await assert.rejects(zip.read('a'), hasCode('INVALID_MANIFEST')); } finally { await zip.close(); }
});

for (const name of ['../a', '/a', 'C:/a', 'a\\b', 'a/%2e%2e/b', 'CON', 'aux.txt', 'a./b', 'a//b']) {
  test(`unsafe archive path is rejected: ${name}`, async () => {
    await assert.rejects(openZip(fixture([{ name }])), hasCode('UNSAFE_PATH'));
  });
}
for (const names of [['a', 'a'], ['a', 'A'], ['root/a', 'ROOT/b'], ['a', 'a/b'], ['a/', 'a']]) {
  test(`duplicate/colliding archive paths are rejected: ${names.join(',')}`, async () => {
    await assert.rejects(openZip(fixture(names.map(name => ({ name })))), hasCode('UNSAFE_PATH'));
  });
}
for (const [label, attrs] of [['symlink', (0o120777 << 16) >>> 0], ['device', (0o020666 << 16) >>> 0], ['reparse', 0x420]]) {
  test(`${label} ZIP attributes are rejected`, async () => {
    await assert.rejects(openZip(fixture([{ name: 'a', attrs }])), hasCode('UNSAFE_PATH'));
  });
}
test('alternate filename extras are rejected', async () => {
  const extra = Buffer.from([0x75, 0x70, 0, 0]);
  await assert.rejects(openZip(fixture([{ name: 'a', extra }])), hasCode('UNSAFE_PATH'));
});
for (const [label, entries, options] of [
  ['central/local name mismatch', [{ name: 'a', localName: 'b' }]],
  ['overlapping local offsets', [{ name: 'a' }, { name: 'b', offset: 0 }]],
  ['bad descriptor', [{ name: 'a', data: Buffer.from('a'), descriptor: true, descriptorCrc: 0 }]],
  ['directory with content', [{ name: 'a/', data: Buffer.from('a') }]],
  ['encryption', [{ name: 'a', flags: 1 }]],
  ['unsupported method', [{ name: 'a', method: 9 }]],
  ['multi-disk', [{ name: 'a' }], { disk: 1 }],
]) {
  test(`${label} is rejected before exposing a stream`, async () => {
    await assert.rejects(openZip(fixture(entries, options)), hasCode('INVALID_MANIFEST'));
  });
}
test('truncated and trailing archives are rejected', async () => {
  const bytes = fixture([{ name: 'a' }]);
  await assert.rejects(openZip(bytes.subarray(0, bytes.length - 1)), hasCode('INVALID_MANIFEST'));
  await assert.rejects(openZip(Buffer.concat([bytes, Buffer.from('extra')])), hasCode('INVALID_MANIFEST'));
});
test('central/local version, flags and timestamp disagreement is rejected', async () => {
  for (const [offset, value] of [[4, 10], [6, 8], [10, 1], [12, 1]]) {
    const bytes = fixture([{ name: 'a' }]); bytes.writeUInt16LE(value, offset);
    await assert.rejects(openZip(bytes), hasCode('INVALID_MANIFEST'));
  }
});
test('nonzero gaps and excessive zero alignment padding are rejected', async () => {
  await assert.rejects(openZip(fixture([{ name: 'a', padding: Buffer.from('hidden') }])), hasCode('INVALID_MANIFEST'));
  await assert.rejects(openZip(fixture([{ name: 'a', padding: Buffer.alloc(65537) }])), hasCode('PACKAGE_LIMIT_EXCEEDED'));
});
test('declared byte/count/archive limits are checked before reads', async () => {
  await assert.rejects(openZip(fixture([{ name: 'a', data: Buffer.alloc(4) }]), { limits: { maxFileBytes: 3 } }), hasCode('PACKAGE_LIMIT_EXCEEDED'));
  await assert.rejects(openZip(fixture([{ name: 'a' }, { name: 'b' }]), { limits: { maxFiles: 1 } }), hasCode('PACKAGE_LIMIT_EXCEEDED'));
  await assert.rejects(openZip(fixture([{ name: 'a' }]), { limits: { maxArchiveBytes: 30 } }), hasCode('PACKAGE_LIMIT_EXCEEDED'));
});
test('writer never replaces an existing file and removes its failed partial output', async t => {
  const directory = await temp(t), existing = path.join(directory, 'existing.zip'), partial = path.join(directory, 'partial.zip');
  await fs.writeFile(existing, 'preserved');
  await assert.rejects(writeZip(existing, [{ name: 'a', data: Buffer.alloc(1) }]));
  assert.equal((await fs.readFile(existing)).toString(), 'preserved');
  await assert.rejects(writeZip(partial, [{ name: 'a', data: Buffer.alloc(10) }], { limits: { maxArchiveBytes: 40 } }), hasCode('PACKAGE_LIMIT_EXCEEDED'));
  await assert.rejects(fs.stat(partial), { code: 'ENOENT' });
});
test('reader and writer honor cancellation and close is idempotent', async t => {
  const directory = await temp(t), target = path.join(directory, 'aborted.zip'), controller = new AbortController(); controller.abort();
  await assert.rejects(writeZip(target, [{ name: 'a', data: Buffer.alloc(1) }], { signal: controller.signal }), hasCode('PACKAGE_ABORTED'));
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  const zip = await openZip(fixture([{ name: 'a', data: Buffer.from('a') }]));
  await assert.rejects(zip.read('a', { signal: controller.signal }), hasCode('PACKAGE_ABORTED'));
  await zip.close(); await zip.close();
  assert.throws(() => zip.stream('a'), hasCode('INVALID_MANIFEST'));
});
test('an in-progress backpressured read is interrupted by its AbortSignal', { timeout: 2000 }, async () => {
  const controller = new AbortController(), zip = await openZip(fixture([{ name: 'a', data: Buffer.alloc(2 * 1024 * 1024) }]));
  const output = zip.stream('a', { signal: controller.signal });
  controller.abort();
  try {
    await assert.rejects((async () => { for await (const chunk of output) void chunk; })(), hasCode('PACKAGE_ABORTED'));
  } finally { await zip.close(); }
});
