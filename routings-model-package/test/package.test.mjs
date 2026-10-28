import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { packModel, verifyPackage, PackageError } from '../index.mjs';
import { writeZip } from '../lib/zip.mjs';
import { hashFile } from '../lib/io.mjs';
import { localModel, archiveEntries } from './fixtures.mjs';

const run = promisify(execFile);
const code = expected => error => error instanceof PackageError && error.code === expected;

test('pack/readback/relocation/extraction preserve all raw resources and source identity', async t => {
  const fixture = await localModel(t);
  const beforeSource = await hashFile(fixture.source);
  const result = await packModel(fixture.options);
  assert.equal(result.status, 'PASS'); assert.equal(result.resourceCount, 4);
  assert.equal(result.sourceIdentity.identityBasis, 'observed-local-file');
  assert.equal(result.manifest.resources.some(item => item.path.endsWith('/properties.db')), true);
  const copy = path.join(fixture.root, 'relocated.zip'); await fs.copyFile(fixture.output, copy);
  // Remove original fixture inputs to prove verifier has no dependency on them.
  await fs.rm(fixture.modelDir, { recursive: true }); await fs.rm(path.dirname(fixture.source), { recursive: true });
  const extracted = path.join(fixture.root, 'extracted');
  const verified = await verifyPackage(copy, { expectedFingerprint: result.contentFingerprint, extractTo: extracted });
  assert.equal(verified.package.sha256, result.package.sha256);
  assert.equal(verified.extraction.hashesCompared, 4);
  for (const [name, bytes] of fixture.data) assert.deepEqual(await fs.readFile(path.join(extracted, 'resources', 'output', '0', name)), bytes);
  assert.equal(verified.manifest.source.sha256, beforeSource.sha256);
});

test('successful retry preserves archive SHA, packageId, preparedAt and leaves no staging/lock/journal', async t => {
  const fixture = await localModel(t);
  const first = await packModel({ ...fixture.options, packageId: undefined, preparedAt: undefined });
  const again = await packModel({ ...fixture.options, packageId: undefined, preparedAt: undefined });
  assert.equal(again.publication.resumed, true);
  assert.equal(again.package.sha256, first.package.sha256);
  assert.equal(again.manifest.packageId, first.manifest.packageId);
  assert.equal(again.manifest.preparedAt, first.manifest.preparedAt);
  assert.deepEqual((await fs.readdir(path.dirname(fixture.output))).sort(), ['fixture.zip', 'fixture.zip.manifest.json', 'fixture.zip.validation.json']);
});

test('failed re-publication leaves the last good ZIP unchanged', async t => {
  const fixture = await localModel(t);
  const good = await packModel(fixture.options);
  await assert.rejects(() => packModel({ ...fixture.options, label: 'Conflicting label' }), code('PACKAGE_ID_CONFLICT'));
  assert.equal((await hashFile(fixture.output)).sha256, good.package.sha256);
  assert.equal((await verifyPackage(fixture.output)).status, 'PASS');
});

test('interrupted reservation keeps its identity and retries it without changing UUID/time', async t => {
  const fixture = await localModel(t);
  // Inject a reserved identity as a persisted record left after a stopped run.
  const source = { name: path.basename(fixture.source), ...(await hashFile(fixture.source)), identityBasis: 'observed-local-file' };
  const good = await packModel(fixture.options);
  await fs.unlink(fixture.output); await fs.unlink(fixture.output + '.manifest.json'); await fs.unlink(fixture.output + '.validation.json');
  await fs.writeFile(fixture.output + '.publication.json', JSON.stringify({ packageId: good.manifest.packageId, label: good.manifest.label, preparedAt: good.manifest.preparedAt, source, contentFingerprint: good.contentFingerprint }));
  const resumed = await packModel({ ...fixture.options, packageId: undefined, preparedAt: undefined });
  assert.equal(resumed.manifest.packageId, good.manifest.packageId);
  assert.equal(resumed.manifest.preparedAt, good.manifest.preparedAt);
});

for (const [kind, expected, mutate] of [
  ['missing', 'RESOURCE_MISSING', entries => entries.filter(entry => !entry.name.endsWith('/properties.db'))],
  ['extra', 'RESOURCE_UNEXPECTED', entries => [...entries, { name: 'README.txt', data: Buffer.from('Forbidden package README') }]],
  ['size', 'RESOURCE_SIZE_MISMATCH', entries => entries.map(entry => entry.name.endsWith('/properties.db') ? { ...entry, data: Buffer.from('SQLite format 3\0') } : entry)],
  ['hash', 'RESOURCE_HASH_MISMATCH', entries => entries.map(entry => { if (!entry.name.endsWith('/properties.db')) return entry; const data = Buffer.from(entry.data); data[data.length - 1] ^= 1; return { ...entry, data }; })],
  ['duplicate manifest keys', 'INVALID_MANIFEST', entries => entries.map(entry => entry.name === 'manifest.json' ? { ...entry, data: Buffer.from(entry.data.toString().replace('"schemaVersion": 1,', '"schemaVersion": 1,"schemaVersion": 1,')) } : entry)],
]) test(`ZIP verifier rejects ${kind} without original input access`, async t => {
  const fixture = await localModel(t); await packModel(fixture.options);
  const malformed = path.join(fixture.root, 'invalid.zip');
  await writeZip(malformed, mutate(await archiveEntries(fixture.output)));
  await assert.rejects(() => verifyPackage(malformed), code(expected));
});

test('input corrupt raw gzip / changed integrity rejects pre-publication', async t => {
  const fixture = await localModel(t);
  const geometry = path.join(fixture.modelDir, 'output', '0', '0.pf');
  const bytes = await fs.readFile(geometry); bytes[bytes.length - 5] ^= 1; await fs.writeFile(geometry, bytes);
  await assert.rejects(() => packModel(fixture.options), code('RESOURCE_HASH_MISMATCH'));
  await assert.rejects(() => fs.stat(fixture.output), { code: 'ENOENT' });
});

test('output/report/extraction cannot overwrite input or pre-existing data', async t => {
  const fixture = await localModel(t);
  await assert.rejects(() => packModel({ ...fixture.options, output: path.join(fixture.modelDir, 'changed.zip') }), code('UNSAFE_PATH'));
  await assert.rejects(() => packModel({ ...fixture.options, report: fixture.source }), code('UNSAFE_PATH'));
  await packModel(fixture.options);
  await assert.rejects(() => verifyPackage(fixture.output, { extractTo: fixture.modelDir }), code('OUTPUT_EXISTS'));
});

test('exclusive lock prevents concurrent publication and recover refuses a live owner', async t => {
  const fixture = await localModel(t);
  await fs.writeFile(fixture.output + '.lock', JSON.stringify({ pid: process.pid }));
  await assert.rejects(() => packModel(fixture.options), code('OUTPUT_BUSY'));
  await assert.rejects(() => packModel({ ...fixture.options, recover: true }), code('OUTPUT_BUSY'));
});

test('stream byte limits and abort prevent partial final outputs', async t => {
  const fixture = await localModel(t);
  await assert.rejects(() => packModel({ ...fixture.options, limits: { maxArchiveBytes: 128 } }), code('PACKAGE_LIMIT_EXCEEDED'));
  await assert.rejects(() => fs.stat(fixture.output), { code: 'ENOENT' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => packModel({ ...fixture.options, signal: controller.signal }), code('PACKAGE_ABORTED'));
});

test('CLI runs from unrelated cwd with no environment/config/network imports', async t => {
  const fixture = await localModel(t);
  const cli = path.resolve('cli.mjs');
  await fs.writeFile(path.join(fixture.root, '.env'), 'DO_NOT_READ=fixture\n');
  const child = await run(process.execPath, [cli, 'pack', '--model-dir', fixture.modelDir, '--source', fixture.source, '--output', fixture.output, '--label', fixture.options.label, '--package-id', fixture.options.packageId, '--prepared-at', fixture.options.preparedAt], { cwd: fixture.root, env: {}, maxBuffer: 1024 * 1024 });
  assert.equal(JSON.parse(child.stdout).status, 'PASS');
  assert.equal(JSON.parse((await run(process.execPath, [cli, 'verify', '--package', fixture.output], { cwd: fixture.root, env: {}, maxBuffer: 1024 * 1024 })).stdout).status, 'PASS');
});

test('CLI usage and failure reports have distinct nonzero exit codes', async t => {
  const fixture = await localModel(t);
  const cli = path.resolve('cli.mjs');
  await assert.rejects(() => run(process.execPath, [cli, 'pack'], { cwd: fixture.root }), error => error.code === 2);
  const report = path.join(fixture.root, 'failure.json');
  await assert.rejects(() => run(process.execPath, [cli, 'verify', '--package', path.join(fixture.root, 'absent.zip'), '--report', report], { cwd: fixture.root }), error => error.code === 1);
  assert.equal(JSON.parse(await fs.readFile(report, 'utf8')).status, 'FAIL');
});

test('invalid UTF-8 in a portable string is rejected rather than replaced', async t => {
  const fixture = await localModel(t); await packModel(fixture.options);
  const entries = await archiveEntries(fixture.output);
  const entry = entries.find(item => item.name === 'manifest.json');
  const index = entry.data.indexOf(Buffer.from('Tiny offline fixture'));
  assert.ok(index > 0); entry.data[index] = 0xff;
  const invalid = path.join(fixture.root, 'invalid-utf8.zip'); await writeZip(invalid, entries);
  await assert.rejects(() => verifyPackage(invalid), code('INVALID_MANIFEST'));
});

test('sidecars cannot alias locks/journals and retry cannot overwrite an unrelated report', async t => {
  const fixture = await localModel(t);
  for (const suffix of ['.lock', '.publication.json']) {
    await assert.rejects(() => packModel({ ...fixture.options, report: fixture.output + suffix }), code('UNSAFE_PATH'));
    await assert.rejects(() => packModel({ ...fixture.options, manifest: fixture.output + suffix }), code('UNSAFE_PATH'));
  }
  const good = await packModel(fixture.options);
  const unrelated = path.join(fixture.root, 'unrelated.json'); await fs.writeFile(unrelated, '{"keep":true}');
  await assert.rejects(() => packModel({ ...fixture.options, report: unrelated }), code('OUTPUT_EXISTS'));
  assert.equal(await fs.readFile(unrelated, 'utf8'), '{"keep":true}');
  assert.equal((await hashFile(fixture.output)).sha256, good.package.sha256);
});

test('an existing output cannot replace the UUID/time reserved by an interrupted journal', async t => {
  const fixture = await localModel(t);
  const good = await packModel(fixture.options);
  await fs.writeFile(fixture.output + '.publication.json', JSON.stringify({ packageId: 'c1eae47c-e209-43ca-acdd-0c2ff6ba8933', label: good.manifest.label, preparedAt: '2026-10-16T09:00:00.000Z', source: good.manifest.source, contentFingerprint: good.contentFingerprint }));
  await assert.rejects(() => packModel({ ...fixture.options, packageId: undefined, preparedAt: undefined }), code('PACKAGE_ID_CONFLICT'));
  assert.equal((await hashFile(fixture.output)).sha256, good.package.sha256);
  assert.equal(JSON.parse(await fs.readFile(fixture.output + '.publication.json', 'utf8')).packageId, 'c1eae47c-e209-43ca-acdd-0c2ff6ba8933');
});

test('concurrent stale-lock recoveries serialize acquisition and preserve publication', async t => {
  const fixture = await localModel(t);
  await fs.writeFile(fixture.output + '.lock', JSON.stringify({ pid: 2147483647, nonce: 'stale' }));
  const results = await Promise.allSettled([packModel({ ...fixture.options, recover: true }), packModel({ ...fixture.options, recover: true })]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter(item => item.status === 'rejected' && item.reason.code === 'OUTPUT_BUSY').length, 1);
  assert.equal((await verifyPackage(fixture.output)).status, 'PASS');
});
