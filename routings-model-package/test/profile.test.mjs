import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { writeZip } from '../lib/zip.mjs';
import { validateProfile } from '../lib/profile.mjs';
import { PackageError } from '../lib/errors.mjs';

const PREFIX = 'resources/output/0/';
const P = 'Autodesk.CloudPlatform.';
const metadata = '{"version":"1.0","metadata":{"default display unit":{"value":"m"}}}';
const material = () => ({
  name: 'LMVTK Simple Materials', version: '1.0', scene: { SceneUnit: 8193, YIsUp: 0 },
  materials: { '0': { version: 2, userassets: ['0'], materials: { '0': {
    tag: '', proteinType: '', definition: 'SimplePhong', transparent: false, textures: {},
    properties: { integers: { mode: 4 }, booleans: { color_by_object: false },
      scalars: { generic_glossiness: { units: '', values: [64] } },
      colors: { generic_diffuse: { values: [{ r: 0.6, g: 0.4, b: 0, a: 1 }] } } },
  } } } },
});

async function fixture(t, options = {}) {
  const tempParent = await fs.realpath(os.tmpdir());
  const temp = await fs.mkdtemp(path.join(tempParent, 'model-profile-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(tempParent));
    assert.ok(path.basename(temp).startsWith('model-profile-test-'));
    await fs.rm(temp, { recursive: true, force: true });
  });
  const data = new Map([
    [PREFIX + 'properties.db', Buffer.from('SQLite format 3\0fixture-data', 'ascii')],
    [PREFIX + '0.pf', gzipSync(Buffer.from(options.binary ?? 'PackFile fixture data'))],
    [PREFIX + 'Materials.json.gz', gzipSync(Buffer.from(options.materialText ?? JSON.stringify(options.material ?? material())))],
  ]);
  const assets = [
    { id: '0.pf', type: P + 'PackFile', URI: '0.pf', size: data.get(PREFIX + '0.pf').length, usize: Buffer.byteLength(options.binary ?? 'PackFile fixture data'), typeset: '2' },
    { id: 'Materials.json.gz', type: 'ProteinMaterials', URI: 'Materials.json.gz', size: data.get(PREFIX + 'Materials.json.gz').length, usize: 0 },
  ];
  for (const [basename, body] of Object.entries(options.properties ?? {})) {
    const types = { 'objects_attrs.json.gz': 'PropertyAttributes', 'objects_avs.json.gz': 'PropertyAVs',
      'objects_ids.json.gz': 'PropertyIDs', 'objects_offs.json.gz': 'PropertyOffsets',
      'objects_vals.json.gz': 'PropertyValues', 'objects_viewables.json.gz': 'PropertyViewables' };
    const bytes = gzipSync(Buffer.from(body));
    data.set(PREFIX + basename, bytes);
    assets.push({ id: basename, type: P + types[basename], URI: basename, size: bytes.length, usize: 0 });
  }
  const meta = Buffer.from(options.metadataText ?? metadata);
  assets.push({ id: 'metadata.json', type: P + 'ViewingMetadata', URI: 'embed:/metadata.json', size: meta.length, usize: meta.length });
  const manifest = { name: 'LMV Manifest', toolkitversion: 'LMVTK 5.0.26.0', manifestversion: 2,
    adskID: { sourceSystem: '', type: '', id: '', version: '' }, assets,
    typesets: [{ id: '2', types: [{ class: P + 'Geometry', type: P + 'OpenCTM', version: 1 }] }],
  };
  options.mutate?.(manifest, data);
  const zipEntries = [{ name: 'manifest.json', data: Buffer.from(options.manifestText ?? JSON.stringify(manifest)) }];
  if (!options.noMetadata) zipEntries.push({ name: 'metadata.json', data: meta });
  for (const item of options.extraEmbedded ?? []) zipEntries.push(item);
  const filename = path.join(temp, '0.svf');
  await writeZip(filename, zipEntries);
  data.set(PREFIX + '0.svf', await fs.readFile(filename));
  options.afterZip?.(data);
  const resources = [...data].map(([resourcePath, bytes]) => ({ path: resourcePath, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const provider = {
    resources,
    async read(resourcePath, { maxBytes = Infinity } = {}) {
      const bytes = data.get(resourcePath);
      if (!bytes) throw new PackageError('RESOURCE_MISSING', 'Missing fixture resource.');
      if (bytes.length > maxBytes) throw new PackageError('PACKAGE_LIMIT_EXCEEDED', 'Fixture read exceeded limit.');
      return bytes;
    },
    stream(resourcePath) {
      const bytes = data.get(resourcePath);
      if (!bytes) throw new PackageError('RESOURCE_MISSING', 'Missing fixture resource.');
      if (!options.chunkBytes) return Readable.from([bytes]);
      const parts = [];
      for (let at = 0; at < bytes.length; at += options.chunkBytes) parts.push(bytes.subarray(at, at + options.chunkBytes));
      return Readable.from(parts);
    },
  };
  return { provider, data, manifest };
}

const rejectsCode = (operation, code) => assert.rejects(operation, error => error instanceof PackageError && error.code === code);

test('supported profile proves closure, raw sizes, gzip integrity and required additional database', async t => {
  const { provider } = await fixture(t);
  const result = await validateProfile(provider);
  assert.equal(result.status, 'PASS');
  assert.equal(result.closure.externalReferences, 2);
  assert.equal(result.closure.embeddedReferences, 1);
  assert.deepEqual(result.closure.additionalResources, ['properties.db']);
  assert.equal(result.gzip.count, 2);
  assert.equal(result.structuredJsonCount, 1);
  assert.equal(result.emptyMaterialTextureMaps, 1);
  assert.equal(result.sizes.resourceCount, 4);
});

test('gzip detection and executable sniffing work across one-byte stream chunks', async t => {
  const { provider } = await fixture(t, { chunkBytes: 1 });
  assert.equal((await validateProfile(provider)).status, 'PASS');
});

test('known equal-valued default display unit duplicate is accepted without mutating raw bytes', async t => {
  const text = '{"version":"1.0","metadata":{"default display unit":{"value":"m"},"default display unit":{"value":"m"}}}';
  const { provider, data } = await fixture(t, { metadataText: text });
  const before = Buffer.from(data.get(PREFIX + '0.svf'));
  assert.equal((await validateProfile(provider)).status, 'PASS');
  assert.deepEqual(data.get(PREFIX + '0.svf'), before);
});

for (const [label, text] of [
  ['conflicting unit', '{"version":"1.0","metadata":{"default display unit":{"value":"m"},"default display unit":{"value":"mm"}}}'],
  ['third identical unit', '{"version":"1.0","metadata":{"default display unit":{"value":"m"},"default display unit":{"value":"m"},"default display unit":{"value":"m"}}}'],
  ['other equal key', '{"version":"1.0","version":"1.0","metadata":{}}'],
]) test(`rejects metadata duplicate: ${label}`, async t => {
  const { provider } = await fixture(t, { metadataText: text });
  await rejectsCode(() => validateProfile(provider), 'INVALID_MANIFEST');
});

test('all six inert property JSON schemas retain textual URLs as property values', async t => {
  const properties = Object.fromEntries(['attrs', 'avs', 'ids', 'offs', 'vals', 'viewables'].map(name => [
    `objects_${name}.json.gz`, '{"value":"https://example.invalid/property-text","other":[1,2,3]}',
  ]));
  const { provider } = await fixture(t, { properties });
  const result = await validateProfile(provider);
  assert.equal(result.structuredJsonCount, 7);
  assert.equal(result.gzip.count, 8);
});

test('property JSON duplicate keys are rejected', async t => {
  const { provider } = await fixture(t, { properties: { 'objects_vals.json.gz': '{"x":1,"x":1}' } });
  await rejectsCode(() => validateProfile(provider), 'INVALID_MANIFEST');
});

test('recognized JSON must be a valid gzip stream containing valid JSON', async t => {
  const { provider } = await fixture(t, { properties: { 'objects_vals.json.gz': 'not JSON' } });
  await rejectsCode(() => validateProfile(provider), 'INVALID_MANIFEST');
});

for (const [label, mutate] of [
  ['unsupported toolkit', manifest => { manifest.toolkitversion = 'LMVTK future'; }],
  ['unsupported manifest version', manifest => { manifest.manifestversion = 3; }],
  ['unknown manifest field', manifest => { manifest.url = 'https://example.invalid/'; }],
  ['unsupported asset type', manifest => { manifest.assets[0].type = 'Unknown.Loader'; }],
  ['absent typeset', manifest => { manifest.assets[0].typeset = 'missing'; }],
  ['unsupported tuple', manifest => { manifest.typesets[0].types[0].version = 100; }],
  ['string tuple version', manifest => { manifest.typesets[0].types[0].version = '1'; }],
  ['unknown asset field', manifest => { manifest.assets[0].url = 'https://example.invalid'; }],
]) test(`rejects ${label}`, async t => {
  const { provider } = await fixture(t, { mutate });
  await rejectsCode(() => validateProfile(provider), 'UNSUPPORTED_PROFILE');
});

test('duplicate SVF loader URI/ID is rejected', async t => {
  const { provider } = await fixture(t, { mutate: manifest => manifest.assets.push({ ...manifest.assets[0] }) });
  await rejectsCode(() => validateProfile(provider), 'INVALID_MANIFEST');
});

for (const uri of ['https://example.invalid/0.pf', '//example.invalid/0.pf', 'file:/tmp/0.pf', 'data:binary,payload', 'urn:external:resource']) {
  test(`rejects external loader URI ${uri.split(':')[0]}`, async t => {
    const { provider } = await fixture(t, { mutate: manifest => { manifest.assets[0].URI = uri; } });
    await rejectsCode(() => validateProfile(provider), 'EXTERNAL_REFERENCE');
  });
}

for (const uri of ['../0.pf', '/0.pf', 'folder/0.pf', '0%2epf', '0.pf?token=x', '0.pf#fragment', 'folder\\0.pf']) {
  test(`rejects non-sibling loader URI ${uri}`, async t => {
    const { provider } = await fixture(t, { mutate: manifest => { manifest.assets[0].URI = uri; } });
    await rejectsCode(() => validateProfile(provider), 'UNSAFE_PATH');
  });
}

test('external SVF size is compared with raw compressed resource bytes', async t => {
  const { provider } = await fixture(t, { mutate: manifest => { manifest.assets[0].size++; } });
  await rejectsCode(() => validateProfile(provider), 'RESOURCE_SIZE_MISMATCH');
});

test('embedded metadata validates compressed and uncompressed ZIP sizes distinctly', async t => {
  const { provider } = await fixture(t, { mutate: manifest => { manifest.assets.at(-1).usize++; } });
  await rejectsCode(() => validateProfile(provider), 'RESOURCE_SIZE_MISMATCH');
});

test('missing embedded metadata fails rather than silently omitting the reference', async t => {
  const { provider } = await fixture(t, { noMetadata: true });
  await rejectsCode(() => validateProfile(provider), 'RESOURCE_MISSING');
});

test('undeclared embedded payload is outside the supported container', async t => {
  const { provider } = await fixture(t, { extraEmbedded: [{ name: 'more.json', data: Buffer.from('{}') }] });
  await rejectsCode(() => validateProfile(provider), 'UNSUPPORTED_PROFILE');
});

test('missing external sibling is rejected', async t => {
  const { provider } = await fixture(t, { afterZip: data => data.delete(PREFIX + '0.pf') });
  await rejectsCode(() => validateProfile(provider), 'RESOURCE_MISSING');
});

test('additional properties.db is mandatory even though it is not in assets', async t => {
  const { provider } = await fixture(t, { afterZip: data => data.delete(PREFIX + 'properties.db') });
  await rejectsCode(() => validateProfile(provider), 'RESOURCE_MISSING');
});

test('extra unreferenced binary is rejected', async t => {
  const { provider } = await fixture(t, { afterZip: data => data.set(PREFIX + 'extra.pf', Buffer.from('data')) });
  await rejectsCode(() => validateProfile(provider), 'RESOURCE_UNEXPECTED');
});

test('a missing raw SQLite signature is unsupported, without executing any SQLite', async t => {
  const { provider } = await fixture(t, { afterZip: data => data.set(PREFIX + 'properties.db', Buffer.from('Not SQLite')) });
  await rejectsCode(() => validateProfile(provider), 'UNSUPPORTED_PROFILE');
});

for (const [label, mutate] of [
  ['nonempty textures', item => { item.materials['0'].materials['0'].textures.diffuse = { URI: 'https://example.invalid/texture.png' }; }],
  ['unknown material field', item => { item.materials['0'].loader = {}; }],
  ['different definition', item => { item.materials['0'].materials['0'].definition = 'PBR'; }],
  ['unknown root reference', item => { item.resources = ['texture.png']; }],
]) test(`rejects material schema: ${label}`, async t => {
  const item = material(); mutate(item);
  const { provider } = await fixture(t, { material: item });
  await rejectsCode(() => validateProfile(provider), 'UNSUPPORTED_PROFILE');
});

test('gzip CRC corruption is rejected with an explicit error', async t => {
  const { provider } = await fixture(t, { mutate: (_manifest, data) => {
    const bytes = Buffer.from(data.get(PREFIX + '0.pf'));
    bytes[bytes.length - 8] ^= 0xff; data.set(PREFIX + '0.pf', bytes);
  } });
  await rejectsCode(() => validateProfile(provider), 'GZIP_INVALID');
});

test('plain replacement of expected gzip JSON is rejected', async t => {
  const { provider } = await fixture(t, { mutate: (manifest, data) => {
    const bytes = Buffer.from('{}'); data.set(PREFIX + 'Materials.json.gz', bytes); manifest.assets[1].size = bytes.length;
  } });
  await rejectsCode(() => validateProfile(provider), 'GZIP_INVALID');
});

for (const [label, binary] of [
  ['Windows executable', 'MZbinary'], ['script', '#!/bin/sh\necho malicious'],
  ['HTML', '<!doctype html><html></html>'], ['JavaScript', 'export const surprise = 1;'],
]) test(`rejects decompressed binary ${label}`, async t => {
  const { provider } = await fixture(t, { binary });
  await rejectsCode(() => validateProfile(provider), 'EXECUTABLE_CONTENT');
});

test('unrecognized nested ZIP in terminal data is rejected', async t => {
  const { provider } = await fixture(t, { binary: 'PK\x03\x04hidden archive' });
  await rejectsCode(() => validateProfile(provider), 'UNSUPPORTED_PROFILE');
});

test('recognized metadata inflation uses actual bytes and stops at its single-file cap', async t => {
  const { provider } = await fixture(t, { properties: { 'objects_vals.json.gz': JSON.stringify('v'.repeat(12000)) } });
  await rejectsCode(() => validateProfile(provider, { limits: { maxNestedBytes: 4096 } }), 'PACKAGE_LIMIT_EXCEEDED');
});

test('recognized metadata inflation also stops at the aggregate nested cap', async t => {
  const { provider } = await fixture(t, { properties: { 'objects_vals.json.gz': JSON.stringify('v'.repeat(5000)) } });
  await rejectsCode(() => validateProfile(provider, { limits: { maxNestedBytes: 20000, maxNestedTotalBytes: 3000 } }), 'PACKAGE_LIMIT_EXCEEDED');
});

test('opaque binary integrity stream is reported separately from inspected metadata limits', async t => {
  const { provider } = await fixture(t, { binary: 'PackFile\n' + 'b'.repeat(10000) });
  const result = await validateProfile(provider, { limits: { maxNestedTotalBytes: 4000 } });
  assert.ok(result.sizes.nestedInflatedBytes < 4000);
  assert.ok(result.sizes.terminalInflatedBytes > 10000);
});

test('opaque binary integrity streams still enforce their resource computational cap', async t => {
  const { provider } = await fixture(t, { binary: 'PackFile\n' + 'b'.repeat(10000) });
  await rejectsCode(() => validateProfile(provider, { limits: { maxFileBytes: 4096 } }), 'PACKAGE_LIMIT_EXCEEDED');
});

test('expansion ratio is independently enforced using streamed inflated bytes', async t => {
  const { provider } = await fixture(t, { binary: 'PackFile\n' + 'b'.repeat(10000) });
  await rejectsCode(() => validateProfile(provider, { limits: { maxExpansionRatio: 20 } }), 'PACKAGE_LIMIT_EXCEEDED');
});

test('profile respects cancellation before opening input', async () => {
  const controller = new AbortController(); controller.abort();
  await rejectsCode(() => validateProfile({}, { signal: controller.signal }), 'PACKAGE_ABORTED');
});

test('in-flight cancellation settles a stalled provider and destroys its owned stream', async t => {
  const { provider } = await fixture(t);
  const controller = new AbortController();
  const originalStream = provider.stream;
  let watched, abortTimer;
  provider.stream = resourcePath => {
    if (!resourcePath.endsWith('0.pf')) return originalStream(resourcePath);
    watched = new Readable({ read() {} });
    abortTimer = setTimeout(() => controller.abort(), 5);
    return watched;
  };
  t.after(() => clearTimeout(abortTimer));
  await rejectsCode(() => validateProfile(provider, { signal: controller.signal }), 'PACKAGE_ABORTED');
  assert.equal(watched.destroyed, true);
});

test('total deadline terminates a stalled integrity stream without a user signal', async t => {
  const { provider } = await fixture(t);
  const originalStream = provider.stream;
  let watched;
  provider.stream = resourcePath => {
    if (!resourcePath.endsWith('0.pf')) return originalStream(resourcePath);
    watched = new Readable({ read() {} });
    return watched;
  };
  await rejectsCode(() => validateProfile(provider, { limits: { maxMs: 100 } }), 'PACKAGE_LIMIT_EXCEEDED');
  assert.equal(watched.destroyed, true);
});

test('provider failure destroys the stream and retains its typed failure', async t => {
  const { provider } = await fixture(t);
  const originalStream = provider.stream;
  let watched;
  provider.stream = resourcePath => {
    if (!resourcePath.endsWith('0.pf')) return originalStream(resourcePath);
    watched = Readable.from((async function* () { throw new PackageError('RESOURCE_MISSING', 'Provider cannot read the resource.'); })());
    return watched;
  };
  await rejectsCode(() => validateProfile(provider), 'RESOURCE_MISSING');
  assert.equal(watched.destroyed, true);
});

test('stream size evidence cannot rely only on manifest/resource metadata', async t => {
  const { provider } = await fixture(t);
  const db = provider.resources.find(item => item.path.endsWith('properties.db')); db.bytes++;
  await rejectsCode(() => validateProfile(provider), 'RESOURCE_SIZE_MISMATCH');
});

test('duplicate/case-colliding resource paths are rejected before profile processing', async t => {
  const { provider } = await fixture(t);
  provider.resources.push({ ...provider.resources[0], path: provider.resources[0].path.toUpperCase() });
  await rejectsCode(() => validateProfile(provider), 'UNSAFE_PATH');
});
