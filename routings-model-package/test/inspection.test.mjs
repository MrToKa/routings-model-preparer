import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeZip } from '../lib/zip.mjs';
import { inspectSvfEnvelope, PackageError } from '../index.mjs';

async function envelope(t, { mutate, metadata, omitMetadata = false, extra = [], manifestText } = {}) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'svf-inspection-'));
  t.after(async () => { assert.equal(path.dirname(root), parent); await fs.rm(root, { recursive: true, force: true }); });
  const meta = Buffer.from(metadata ?? '{"version":"1.0","metadata":{"default display unit":{"value":"m"}}}');
  const manifest = { name: 'LMV Manifest', toolkitversion: 'LMVTK 5.0.26.0', manifestversion: 2,
    adskID: { sourceSystem: '', type: '', id: '', version: '' },
    assets: [{ id: '0.pf', type: 'Autodesk.CloudPlatform.PackFile', URI: '0.pf', size: 41, usize: 21, typeset: '2' },
      { id: 'metadata', type: 'Autodesk.CloudPlatform.ViewingMetadata', URI: 'embed:/metadata.json', size: meta.length, usize: meta.length }],
    typesets: [{ id: '2', types: [{ class: 'Autodesk.CloudPlatform.Geometry', type: 'Autodesk.CloudPlatform.OpenCTM', version: 1 }] }],
  };
  mutate?.(manifest);
  const entries = [{ name: 'manifest.json', data: Buffer.from(manifestText ?? JSON.stringify(manifest)) }, ...(!omitMetadata ? [{ name: 'metadata.json', data: meta }] : []), ...extra];
  const filename = path.join(root, '0.svf'); await writeZip(filename, entries); return fs.readFile(filename);
}
const rejects = (promise, code) => assert.rejects(promise, error => error instanceof PackageError && error.code === code);
test('public inspection returns stable declarations without claiming external closure', async t => {
  const bytes = await envelope(t), copy = Buffer.from(bytes), result = await inspectSvfEnvelope(bytes);
  assert.equal(result.status, 'INSPECTED'); assert.equal(result.resourceClosureVerified, false);
  assert.equal(result.supportProfile, 'svf-local-7.130.0-v1');
  assert.deepEqual(result.resources, [{ path: 'output/0/0.pf', bytes: 41, inflatedBytes: 21, assetType: 'Autodesk.CloudPlatform.PackFile' }]);
  assert.deepEqual(result.additionalResources, ['output/0/properties.db']); assert.ok(copy.equals(bytes));
});
test('inspection refuses unsupported toolkit before dependency discovery', async t => {
  await rejects(inspectSvfEnvelope(await envelope(t, { mutate: value => { value.toolkitversion = 'future'; } })), 'UNSUPPORTED_PROFILE');
});
test('inspection rejects external and encoded loader references', async t => {
  await rejects(inspectSvfEnvelope(await envelope(t, { mutate: value => { value.assets[0].URI = 'https://example.com/a.pf'; } })), 'EXTERNAL_REFERENCE');
  await rejects(inspectSvfEnvelope(await envelope(t, { mutate: value => { value.assets[0].URI = '%2e%2e.pf'; } })), 'UNSAFE_PATH');
});
test('inspection requires correctly sized embedded metadata and known structures', async t => {
  await rejects(inspectSvfEnvelope(await envelope(t, { omitMetadata: true })), 'RESOURCE_MISSING');
  await rejects(inspectSvfEnvelope(await envelope(t, { mutate: value => { value.assets[1].size++; } })), 'RESOURCE_SIZE_MISMATCH');
  await rejects(inspectSvfEnvelope(await envelope(t, { extra: [{ name: 'active.js', data: Buffer.from('active') }] })), 'UNSUPPORTED_PROFILE');
});
test('only the known equal-valued metadata duplicate remains permitted', async t => {
  const known = '{"version":"1.0","metadata":{"default display unit":{"value":"m"},"default display unit":{"value":"m"}}}';
  assert.equal((await inspectSvfEnvelope(await envelope(t, { metadata: known }))).status, 'INSPECTED');
  await rejects(inspectSvfEnvelope(await envelope(t, { metadata: known.replace('"m"}}}', '"ft"}}}') })), 'INVALID_MANIFEST');
  await rejects(inspectSvfEnvelope(await envelope(t, { manifestText: '{"name":"a","name":"b"}' })), 'INVALID_MANIFEST');
});
test('inspection enforces raw, nested and count caps and abort', async t => {
  const bytes = await envelope(t);
  await rejects(inspectSvfEnvelope(bytes, { limits: { maxNestedBytes: 32 } }), 'PACKAGE_LIMIT_EXCEEDED');
  await rejects(inspectSvfEnvelope(bytes, { limits: { maxManifestBytes: 32 } }), 'PACKAGE_LIMIT_EXCEEDED');
  await rejects(inspectSvfEnvelope(bytes, { limits: { maxFiles: 2 } }), 'PACKAGE_LIMIT_EXCEEDED');
  const controller = new AbortController(); controller.abort(); await rejects(inspectSvfEnvelope(bytes, { signal: controller.signal }), 'PACKAGE_ABORTED');
});

test('SVF v2 from LMVTK 5.0.43.0 is inspected without rewriting its bytes', async t => {
  const bytes = await envelope(t, { mutate: value => { value.toolkitversion = 'LMVTK 5.0.43.0'; } });
  const before = Buffer.from(bytes), result = await inspectSvfEnvelope(bytes);
  assert.equal(result.status, 'INSPECTED');
  assert.equal(result.resourceClosureVerified, false);
  assert.deepEqual(result.resources, [{ path: 'output/0/0.pf', bytes: 41, inflatedBytes: 21, assetType: 'Autodesk.CloudPlatform.PackFile' }]);
  assert.deepEqual(bytes, before);
});

for (const version of ['LMVTK 5.0.42.0', 'LMVTK 5.0.44.0', 'LMVTK 5.0.43.0 ', '5.0.43.0']) {
  test('toolkit allowlist rejects unapproved spelling: ' + version, async t => {
    await rejects(inspectSvfEnvelope(await envelope(t, { mutate: value => { value.toolkitversion = version; } })), 'UNSUPPORTED_PROFILE');
  });
}

for (const [name, mutate, code] of [
  ['manifest v3', value => { value.manifestversion = 3; }, 'UNSUPPORTED_PROFILE'],
  ['unknown geometry tuple', value => { value.typesets[0].types[0].version = 100; }, 'UNSUPPORTED_PROFILE'],
  ['external resource', value => { value.assets[0].URI = 'https://example.invalid/0.pf'; }, 'EXTERNAL_REFERENCE'],
  ['unrecognized manifest field', value => { value.futureLoader = true; }, 'UNSUPPORTED_PROFILE'],
]) {
  test('5.0.43.0 still rejects ' + name, async t => {
    await rejects(inspectSvfEnvelope(await envelope(t, { mutate: value => { value.toolkitversion = 'LMVTK 5.0.43.0'; mutate(value); } })), code);
  });
}

for (const [name, mutate, fields] of [
  ['unknown Autodesk asset type', value => { value.assets[0].type = 'Autodesk.CloudPlatform.UnknownFixture'; }, ['type']],
  ['negative uncompressed size', value => { value.assets[0].usize = -1; }, ['usize']],
  ['numeric asset ID', value => { value.assets[0].id = 17; }, ['id']],
  ['invalid URI type', value => { value.assets[0].URI = null; }, ['URI']],
]) {
  test('asset rejection identifies ' + name + ' without logging private values', async t => {
    const bytes = await envelope(t, { mutate: value => {
      value.toolkitversion = 'LMVTK 5.0.43.0';
      value.assets[0].id = 'PRIVATE_MODEL_IDENTIFIER';
      value.assets[0].URI = 'PRIVATE_RESOURCE.pf';
      mutate(value);
    } });
    const messages = [], previous = process.stderr.write;
    process.stderr.write = function (chunk) { messages.push(String(chunk)); return true; };
    try { await rejects(inspectSvfEnvelope(bytes), 'UNSUPPORTED_PROFILE'); }
    finally { process.stderr.write = previous; }
    const diagnostic = messages.map(line => JSON.parse(line)).find(row => row.reason === 'Invalid or unsupported SVF asset.');
    assert.ok(diagnostic);
    assert.equal(diagnostic.assetIndex, 0);
    assert.deepEqual(diagnostic.invalidAssetFields, fields);
    if (fields.includes('type')) assert.equal(diagnostic.assetType, 'Autodesk.CloudPlatform.UnknownFixture');
    if (fields.includes('usize')) assert.equal(diagnostic.usize, -1);
    assert.ok(!messages.join('').includes('PRIVATE_'));
  });
}
