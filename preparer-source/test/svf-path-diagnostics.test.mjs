import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { contextFromSpec, digest } from '../lib/contracts.mjs';
import { tinyModel } from './fixtures/model-fixture.mjs';
import { describeAssetPath, diagnoseSVFPaths } from '../tools/diagnose-svf-paths.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const preparerDirectory = fileURLToPath(new URL('../', import.meta.url));
const packageModulePath = fileURLToPath(new URL('../../routings-model-package/index.mjs', import.meta.url));
const json = value => ({ statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify(value)) });

for (const [uri, expected] of [
  ['../../textures/private-client-logo.png', { shape: '../../textures/<name>', suffix: '.png', parentSegments: 2 }],
  ['./private-model.pf', { shape: './<name>', suffix: '.pf', leadingDotSlash: true }],
  ['private folder/private%20image.PNG', { shape: '<name>/<name>', suffix: '.png', space: true, percentEscapes: ['20'] }],
  ['private\\private-image.jpg', { shape: '<name>\\<name>', suffix: '.jpg', backslash: true }],
  ['https://private.invalid/?access_token=never-log', { shape: 'scheme-or-network-address' }],
  ['image.png?access_token=never-log', { shape: '<name>', suffix: '.png', queryOrFragment: true }],
]) {
  test(`path diagnosis preserves structural flags without private resource names (${expected.shape})`, () => {
    const row = describeAssetPath({ URI: uri, type: 'Autodesk.CloudPlatform.Image', size: 42, usize: 42 }, 0);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(row[key], value);
    assert.equal(JSON.stringify(row).includes('private'), false);
    assert.equal(JSON.stringify(row).includes('access_token'), false);
    assert.equal(JSON.stringify(row).includes('never-log'), false);
  });
}

async function fixture(t) {
  const base = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(base, 'svf-path-diagnostic-'));
  t.after(async () => { assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('svf-path-diagnostic-')); await fs.rm(root, { recursive: true, force: true }); });
  const data = path.join(root, 'data'), work = path.join(root, 'work'), core = path.join(data, 'live/core');
  const settings = { enabled: true, clientId: 'fixture-client-12345', clientSecret: 'fixture-secret-never-log', bucket: 'fixture-bucket', region: 'EMEA' };
  const origin = 'http://host.docker.internal:5173', namespace = { account: 'team-' + sha('aps-account:' + settings.clientId), application: 'app-' + sha(settings.clientId) };
  for (const dir of ['records/job', 'records/submission', 'records/target', 'records/cost', 'snapshots', 'locks', 'heads']) await fs.mkdir(path.join(core, dir), { recursive: true });
  await fs.mkdir(path.join(work, 'live/core-work'), { recursive: true });
  const journal = path.join(data, 'workspace-journal/operations'), privateDirectory = path.join(data, 'workspace-private');
  await fs.mkdir(journal, { recursive: true }); await fs.mkdir(privateDirectory, { recursive: true });
  const identity = { schemaVersion: 1, storeId: randomUUID(), createdAt: new Date().toISOString() };
  await fs.writeFile(path.join(core, 'store.json'), JSON.stringify({ ...identity, checksum: digest(identity) }));
  const jobId = randomUUID(), operationId = randomUUID();
  const context = contextFromSpec({ namespace, region: 'EMEA', destination: { bucket: 'target-' + sha(settings.bucket), objectKey: 'Fixture.nwd' },
    conversion: { format: 'svf', views: ['3d'], xAdsForce: false }, supportProfile: 'svf-local-7.130.0-v1', label: 'Fixture', output: path.join(root, 'result.zip') },
    { name: 'Fixture.nwd', bytes: 42, sha256: sha('fixture'), snapshotPath: path.join(root, 'Fixture.nwd'), capturedAt: new Date().toISOString() });
  const recordBody = { schemaVersion: 1, kind: 'job', key: jobId, revision: 1, previousHash: null, committedAt: new Date().toISOString(), value: { jobId, frozen: context } };
  const record = { ...recordBody, recordHash: digest(recordBody) };
  const headBody = { schemaVersion: 1, kind: 'job', key: jobId, revision: 1, recordHash: record.recordHash };
  const recordDirectory = path.join(core, 'records/job', jobId); await fs.mkdir(recordDirectory);
  const recordPath = path.join(recordDirectory, '0000000000000001.json');
  await fs.writeFile(recordPath, JSON.stringify(record));
  await fs.writeFile(path.join(core, 'heads', digest({ kind: 'job', key: jobId }) + '.json'), JSON.stringify({ ...headBody, checksum: digest(headBody) }));
  const objectId = `urn:adsk.objects:os.object:${settings.bucket}/Fixture.nwd`, urn = Buffer.from(objectId).toString('base64url');
  const derivative = `urn:adsk.viewing:fs.file:${urn}/output/0/0.svf`, rootId = 'aps-root-' + sha(derivative);
  await fs.writeFile(path.join(journal, operationId + '.json'), JSON.stringify({ value: { id: operationId, jobId, status: 'failed', stage: 'download-' + rootId, updatedAt: new Date().toISOString() } }));
  const key = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('routings-model-preparer/workspace-security/v1/' + origin));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ schemaVersion: 1, wfcOrigin: origin, settings, sessions: {} })), cipher.final()]);
  await fs.writeFile(path.join(privateDirectory, 'workspace.key'), key);
  await fs.writeFile(path.join(privateDirectory, 'workspace.enc'), JSON.stringify({ schemaVersion: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') }));
  const raw = tinyModel().data.get('output/0/0.svf'), calls = [], outputs = [];
  const options = { submissionIdentity: context.submissionIdentity, preparerDirectory, env: { PREPARER_DATA_DIR: data, PREPARER_WORK_DIR: work, PREPARER_PACKAGE_MODULE: packageModulePath, PREPARER_WFC_ORIGIN: origin }, emit: value => outputs.push(value), request: async input => {
    calls.push(input); const url = new URL(input.url);
    if (url.pathname === '/authentication/v2/token') {
      assert.match(input.body, /data%3Aread/); assert.doesNotMatch(input.body, /data%3Awrite/);
      return json({ access_token: 'fixture-token-never-log', expires_in: 3600 });
    }
    assert.equal(input.method, 'GET');
    if (url.pathname.endsWith('/manifest')) return json({ urn, status: 'success', derivatives: [{ children: [{ role: '3d', children: [{ mime: 'application/autodesk-svf', urn: derivative }, { mime: 'application/autodesk-db', role: 'Autodesk.CloudPlatform.PropertyDatabase', urn: derivative.replace('0.svf', 'properties.db') }] }] }] });
    if (url.pathname.endsWith('/signedcookies')) return { ...json({ url: 'https://cdn.derivative.autodesk.com/private/0.svf', size: raw.length, expiration: Date.now() + 60000 }), headers: { 'set-cookie': ['CloudFront-Policy=private-policy; Path=/', 'CloudFront-Signature=private-signature; Path=/', 'CloudFront-Key-Pair-Id=private-key; Path=/'] } };
    if (url.hostname === 'cdn.derivative.autodesk.com') return { statusCode: 200, headers: { 'content-length': String(raw.length) }, body: raw };
    throw new Error('Unexpected fixture request');
  } };
  return { root, options, calls, outputs, recordPath, raw };
}
async function inventory(directory) {
  const result = {};
  for (const row of await fs.readdir(directory, { withFileTypes: true })) {
    const p = path.join(directory, row.name);
    if (row.isDirectory()) for (const [name, hash] of Object.entries(await inventory(p))) result[row.name + '/' + name] = hash;
    else result[row.name] = sha(await fs.readFile(p));
  }
  return result;
}
test('isolated diagnosis reads one SVF with read-only credentials and leaves every state/work file unchanged', async t => {
  const f = await fixture(t), before = await inventory(f.root);
  const report = await diagnoseSVFPaths(f.options);
  assert.equal(report.svfBytes, f.raw.length); assert.equal(report.assetCount, 2); assert.equal(report.rejectedPathCount, 0);
  assert.equal(f.calls.length, 4); assert.equal(f.calls.filter(row => row.url.endsWith('/signedcookies')).length, 1);
  assert.equal(f.outputs.length, 1); assert.deepEqual(await inventory(f.root), before);
  const output = JSON.stringify(f.outputs);
  for (const forbidden of ['fixture-secret', 'fixture-token', 'private-policy', 'private-signature', 'https:', 'Fixture.nwd']) assert.equal(output.includes(forbidden), false);
});
test('corrupt committed state is refused before any cloud request', async t => {
  const f = await fixture(t); await fs.writeFile(f.recordPath, '{}');
  await assert.rejects(diagnoseSVFPaths(f.options), error => error.code === 'STORE_CORRUPT');
  assert.equal(f.calls.length, 0); assert.equal(f.outputs.length, 0);
});
test('a different submission cannot be selected or downloaded implicitly', async t => {
  const f = await fixture(t);
  await assert.rejects(diagnoseSVFPaths({ ...f.options, submissionIdentity: 'a'.repeat(64) }), error => error.code === 'DIAGNOSTIC_FAILED_DOWNLOAD_NOT_FOUND');
  assert.equal(f.calls.length, 0); assert.equal(f.outputs.length, 0);
});
