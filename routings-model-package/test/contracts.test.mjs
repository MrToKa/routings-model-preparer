import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PackageError, fail } from '../lib/errors.mjs';
import { DEFAULT_LIMITS, resolveLimits } from '../lib/limits.mjs';
import { parseJson } from '../lib/json.mjs';
import { validateResourcePath, validateArchivePath, assertNoCaseCollisions, assertLocalNoLinks } from '../lib/paths.mjs';
import { validateManifest, parseManifest, canonicalFingerprintInput, computeFingerprint } from '../lib/manifest.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const GOLDEN = '16cedf8a268704f0a6fa586b53923eb7b828e03bb2b22272502bc13de0be3c08';
const entrypoint = 'resources/output/0/0.svf';
const fixture = () => ({
  schemaVersion: 1,
  packageId: '93e786c2-3ab4-4f85-a9bb-52a4e47a5a4e',
  label: 'Small offline fixture',
  source: { name: 'original.nwd', bytes: 10, sha256: SHA_A, identityBasis: 'observed-local-file' },
  preparedAt: '2026-10-16T07:00:00.000Z',
  supportProfile: 'svf-local-7.130.0-v1', format: 'svf', sdkVersion: '7.130.0', entrypoint,
  resources: [
    { path: entrypoint, bytes: 3, sha256: SHA_A },
    { path: 'resources/output/0/properties.db', bytes: 5, sha256: SHA_B },
  ],
  contentFingerprint: GOLDEN,
});
const rejects = (operation, code = 'INVALID_MANIFEST') => assert.throws(operation, (error) => error instanceof PackageError && error.code === code);

test('errors retain stable code and structured details', () => {
  rejects(() => fail('RESOURCE_MISSING', 'Missing fixture.', { path: 'safe.db' }), 'RESOURCE_MISSING');
  const error = new PackageError('UNSAFE_PATH', 'Unsafe.', { path: '../bad' });
  assert.equal(error.name, 'PackageError');
  assert.deepEqual(error.details, { path: '../bad' });
});

test('exact limits match the v1 byte/count/depth/ratio profile', () => {
  assert.deepEqual(DEFAULT_LIMITS, {
    maxArchiveBytes: 2147483648, maxTotalResourceBytes: 8589934592, maxFiles: 100000,
    maxFileBytes: 2147483648, maxManifestBytes: 33554432, maxNestedBytes: 268435456,
    maxNestedTotalBytes: 1073741824, maxDepth: 16, maxExpansionRatio: 1200, maxMs: 600000,
  });
  assert.ok(Object.isFrozen(DEFAULT_LIMITS));
  assert.equal(resolveLimits({ maxFiles: 2 }).maxFiles, 2);
  rejects(() => resolveLimits({ maxFiles: 100001 }));
  rejects(() => resolveLimits({ unknown: 1 }));
  rejects(() => resolveLimits({ maxFiles: 0 }));
});

test('JSON parser handles arrays, literals, escapes and Unicode without altering values', () => {
  assert.deepEqual(parseJson('{"a":[true,false,null,-1.5e2],"s":"\\u0041\\n\\t\\\\\\\"/😀"}'), { a: [true, false, null, -150], s: 'A\n\t\\"/😀' });
  assert.equal(parseJson(' 42 \r\n'), 42);
});

test('JSON parser rejects duplicate, escaped and nested keys by default', () => {
  for (const input of ['{"x":1,"x":1}', '{"x":1,"\\u0078":1}', '{"a":{"x":1,"x":2}}', '[{"x":null,"x":false}]']) rejects(() => parseJson(input));
});

test('JSON duplicate exception is explicit, scoped and value-aware', () => {
  const allowDuplicate = ({ path: location, key, previous, value }) => location === '$.metadata["default display unit"]'
    && key === 'default display unit' && Object.keys(previous).length === 1 && Object.keys(value).length === 1
    && previous.value === 'm' && value.value === 'm';
  const good = '{"metadata":{"default display unit":{"value":"m"},"default display unit":{"value":"m"}}}';
  assert.equal(parseJson(good, { allowDuplicate }).metadata['default display unit'].value, 'm');
  rejects(() => parseJson(good.replace(/"m"}}}$/, '"ft"}}}'), { allowDuplicate }));
  rejects(() => parseJson('{"default display unit":{"value":"m"},"default display unit":{"value":"m"}}', { allowDuplicate }));
  rejects(() => parseJson('{"x":1,"x":1}', { allowDuplicate: () => 1 }));
});

test('JSON syntax and finite-number enforcement covers malformed documents', () => {
  for (const input of ['', '\uFEFF{}', '{"x":1,}', '[1,]', '{x:1}', '{"x" 1}', '01', '+1', '1.', '1e', '1e400', '{"x":"\n"}', '"\\q"', '"\\uXX00"', 'true false', '"unfinished']) rejects(() => parseJson(input));
});

test('JSON nesting is bounded; own __proto__ never mutates object prototype', () => {
  assert.deepEqual(parseJson('{"x":[1]}', { maxDepth: 2 }), { x: [1] });
  rejects(() => parseJson('{"x":[{}]}', { maxDepth: 2 }), 'PACKAGE_LIMIT_EXCEEDED');
  const parsed = parseJson('{"__proto__":{"polluted":true}}');
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(Object.hasOwn(parsed, '__proto__'), true);
  assert.equal({}.polluted, undefined);
});

test('safe resource/archive paths preserve canonical ASCII identity', () => {
  assert.equal(validateResourcePath(entrypoint), entrypoint);
  assert.equal(validateArchivePath('manifest.json'), 'manifest.json');
  assert.equal(validateArchivePath('resources/output/0/', { allowDirectory: true }), 'resources/output/0/');
  assert.equal(validateResourcePath(`resources/${'a'.repeat(255)}.db`.replace('.db', '')), `resources/${'a'.repeat(255)}`);
});

test('unsafe resource paths reject traversal, URI, encoding, controls and Windows names', () => {
  const values = ['', '/resources/a.db', 'resources//a.db', 'resources/../a.db', 'resources/./a.db', 'resources/a.db/', 'resources\\a.db', 'C:/a.db', '//server/share/a.db', 'resources/a%2Edb', 'resources/a.db?x', 'resources/a.db#x', 'resources/a\u0000.db', 'resources/é.db', 'resources/CON.db', 'resources/prn.bin', 'resources/COM1/x.db', 'resources/lpt9.db', 'resources/a./x.db', `resources/${'a'.repeat(256)}`, 'output/a.db'];
  for (const value of values) rejects(() => validateResourcePath(value), 'UNSAFE_PATH');
  rejects(() => validateResourcePath(`resources/${Array.from({ length: 6 }, () => 'a'.repeat(200)).join('/')}`), 'UNSAFE_PATH');
});

test('case collisions include path prefixes and file/parent aliases', () => {
  assertNoCaseCollisions(['resources/', 'resources/a.db', 'resources/b.db']);
  for (const values of [['resources/a.db', 'resources/a.db'], ['resources/A.db', 'resources/a.db'], ['resources/A/x.db', 'resources/a/y.db'], ['resources/a.db', 'resources/a.db/b.db'], ['resources/a.db/', 'resources/a.db']]) rejects(() => assertNoCaseCollisions(values), 'UNSAFE_PATH');
});

test('valid manifest roundtrips without mutation', () => {
  const manifest = fixture();
  assert.equal(validateManifest(manifest), manifest);
  assert.deepEqual(parseManifest(JSON.stringify(manifest)), manifest);
  assert.equal(computeFingerprint(manifest), GOLDEN);
});

test('each portable root, source and resource field is required', async (t) => {
  for (const key of Object.keys(fixture())) await t.test(`root ${key}`, () => { const m = fixture(); delete m[key]; rejects(() => validateManifest(m)); });
  for (const key of Object.keys(fixture().source)) await t.test(`source ${key}`, () => { const m = fixture(); delete m.source[key]; rejects(() => validateManifest(m)); });
  for (const key of Object.keys(fixture().resources[0])) await t.test(`resource ${key}`, () => { const m = fixture(); delete m.resources[0][key]; rejects(() => validateManifest(m)); });
});

test('portable objects reject unknown fields and duplicate decoded JSON keys', () => {
  for (const target of ['root', 'source', 'resource']) {
    const m = fixture();
    (target === 'root' ? m : target === 'source' ? m.source : m.resources[0]).projectId = 'forbidden';
    rejects(() => validateManifest(m));
  }
  const text = JSON.stringify(fixture());
  rejects(() => parseManifest(text.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')));
  rejects(() => parseManifest(text.replace('"schemaVersion":1', '"schemaVersion":1,"\\u0073chemaVersion":1')));
  rejects(() => parseManifest(text.replace('"source":{', '"source":{"name":"original.nwd",')));
  rejects(() => parseManifest(text.replace('"resources":[{', '"resources":[{"bytes":3,')));
  rejects(() => parseManifest(text.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'), { allowDuplicate: () => true }));
});

test('schema/profile/SDK errors retain their dedicated codes', () => {
  const schema = fixture(); schema.schemaVersion = 2; rejects(() => validateManifest(schema), 'UNSUPPORTED_SCHEMA');
  for (const [key, value] of [['supportProfile', 'future'], ['format', 'svf2'], ['sdkVersion', '7.131.0'], ['entrypoint', 'resources/output/0/other.svf']]) {
    const m = fixture(); m[key] = value; rejects(() => validateManifest(m), 'UNSUPPORTED_PROFILE');
  }
});

test('UUID/hash strings and numeric fields are strict and safe', () => {
  for (const id of ['93E786C2-3AB4-4F85-A9BB-52A4E47A5A4E', '93e786c2-3ab4-1f85-a9bb-52a4e47a5a4e', 'not-a-uuid']) { const m = fixture(); m.packageId = id; rejects(() => validateManifest(m)); }
  for (const value of [-1, -0, 1.5, '3', Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) { const m = fixture(); m.source.bytes = value; rejects(() => validateManifest(m)); }
  for (const value of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), null]) {
    const m = fixture(); m.source.sha256 = value; rejects(() => validateManifest(m));
    const n = fixture(); n.contentFingerprint = value; rejects(() => validateManifest(n));
  }
});

test('Unicode label/source lengths count codepoints and reject controls/unsafe basenames', () => {
  const m = fixture(); m.label = '😀'.repeat(200); m.source.name = `${'😀'.repeat(251)}.nwd`; validateManifest(m);
  for (const value of ['', ' padded ', '😀'.repeat(201), 'line\ntext', '\uD800', '\u202Ehidden']) { const n = fixture(); n.label = value; rejects(() => validateManifest(n)); }
  for (const value of ['../original.nwd', 'C:original.nwd', 'CON.nwd', 'name.', '😀'.repeat(256), 'dir\\original.nwd', 'name%2Enwd']) { const n = fixture(); n.source.name = value; rejects(() => validateManifest(n)); }
  const n = fixture(); n.source.identityBasis = 'assumed'; rejects(() => validateManifest(n));
});

test('RFC3339 UTC dates require real calendar dates and seconds', () => {
  for (const date of ['2024-02-29T23:59:59Z', '2026-10-16T07:00:00.123456Z']) { const m = fixture(); m.preparedAt = date; validateManifest(m); }
  for (const date of ['2025-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-00-01T00:00:00Z', '2026-10-16T24:00:00Z', '2026-10-16T07:00:60Z', '2026-10-16T07:00:00+00:00', '2026-10-16', '0000-01-01T00:00:00Z']) { const m = fixture(); m.preparedAt = date; rejects(() => validateManifest(m)); }
});

test('resource limits apply count, per-file, total and root-manifest bytes', () => {
  rejects(() => validateManifest(fixture(), { limits: { maxFiles: 1 } }), 'PACKAGE_LIMIT_EXCEEDED');
  rejects(() => validateManifest(fixture(), { limits: { maxFileBytes: 4 } }), 'PACKAGE_LIMIT_EXCEEDED');
  rejects(() => validateManifest(fixture(), { limits: { maxTotalResourceBytes: 7 } }), 'PACKAGE_LIMIT_EXCEEDED');
  rejects(() => parseManifest(JSON.stringify(fixture()), { limits: { maxManifestBytes: 10 } }), 'PACKAGE_LIMIT_EXCEEDED');
  const m = fixture(); m.resources[0].bytes = 2147483649; rejects(() => validateManifest(m), 'PACKAGE_LIMIT_EXCEEDED');
});

test('entrypoint, resource suffixes, sorted publication and case safety are enforced', () => {
  const empty = fixture(); empty.resources = []; rejects(() => validateManifest(empty));
  const missing = fixture(); missing.resources.shift(); rejects(() => validateManifest(missing), 'RESOURCE_MISSING');
  const unsorted = fixture(); unsorted.resources.reverse(); rejects(() => validateManifest(unsorted));
  const duplicate = fixture(); duplicate.resources.push({ ...duplicate.resources[1] }); rejects(() => validateManifest(duplicate));
  const executable = fixture(); executable.resources.push({ path: 'resources/x.mjs', bytes: 0, sha256: SHA_A }); rejects(() => validateManifest(executable), 'EXECUTABLE_CONTENT');
  const unknown = fixture(); unknown.resources.push({ path: 'resources/x.zip', bytes: 0, sha256: SHA_A }); rejects(() => validateManifest(unknown), 'UNSUPPORTED_PROFILE');
  const collision = fixture(); collision.resources.splice(1, 0, { path: 'resources/output/0/A.db', bytes: 0, sha256: SHA_A }, { path: 'resources/output/0/a.db', bytes: 0, sha256: SHA_B }); rejects(() => validateManifest(collision), 'UNSAFE_PATH');
});

test('golden canonical bytes are LF-only UTF8 and independent from implementation constants', () => {
  const expected = 'wfc-model-content-v1\nschemaVersion=1\nsupportProfile=svf-local-7.130.0-v1\nformat=svf\nsdkVersion=7.130.0\nentrypoint=resources/output/0/0.svf\nresources/output/0/0.svf\t3\taaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nresources/output/0/properties.db\t5\tbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n';
  assert.deepEqual(canonicalFingerprintInput(fixture()), Buffer.from(expected, 'utf8'));
  assert.equal(canonicalFingerprintInput(fixture()).length, 331);
  assert.equal(computeFingerprint(fixture()), GOLDEN);
});

test('fingerprint sorts a copy but published manifest must still be sorted', () => {
  const m = fixture(); m.resources.reverse();
  const before = JSON.stringify(m.resources);
  assert.equal(computeFingerprint(m), GOLDEN);
  assert.equal(JSON.stringify(m.resources), before);
  rejects(() => validateManifest(m));
});

test('fingerprint excludes identity/cosmetic/source fields and includes all content/profile fields', () => {
  const m = fixture(); m.packageId = '861c48f4-52bf-4e12-8753-dd8009d44423'; m.label = 'Changed'; m.source = { name: 'different.nwd', bytes: 9, sha256: SHA_B, identityBasis: 'captured-at-conversion' }; m.preparedAt = '2026-10-17T00:00:00Z'; m.contentFingerprint = SHA_B;
  assert.equal(computeFingerprint(m), GOLDEN);
  for (const field of ['schemaVersion', 'supportProfile', 'format', 'sdkVersion', 'entrypoint']) { const n = fixture(); n[field] = field === 'schemaVersion' ? 2 : `${n[field]}-changed`; assert.notEqual(computeFingerprint(n), GOLDEN); }
  for (const [field, value] of [['path', 'resources/output/0/changed.svf'], ['bytes', 4], ['sha256', SHA_B]]) { const n = fixture(); n.resources[0][field] = value; assert.notEqual(computeFingerprint(n), GOLDEN); }
});

test('schema is machine-readable draft2020-12 with strict nested objects and runtime annotations', async () => {
  const schema = parseJson(await fs.readFile(new URL('../schemas/portable-manifest-v1.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.$defs.source.additionalProperties, false);
  assert.equal(schema.$defs.resource.additionalProperties, false);
  assert.match(schema.$comment, /duplicate JSON keys/);
  assert.equal(schema.properties.resources.maxItems, DEFAULT_LIMITS.maxFiles);
});

async function temporary(t) {
  // Windows TEMP can use an 8.3 spelling; fixtures use the canonical location
  // so the local-path check can conservatively reject resolving aliases.
  const canonicalTemporaryRoot = await fs.realpath(os.tmpdir());
  const base = await fs.mkdtemp(path.join(canonicalTemporaryRoot, 'routings-contract-'));
  t.after(async () => {
    const resolved = path.resolve(base);
    assert.equal(path.dirname(resolved), path.resolve(canonicalTemporaryRoot));
    assert.ok(path.basename(resolved).startsWith('routings-contract-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return base;
}

test('local path checks accept ordinary files/directories and reject hardlinks', async (t) => {
  const base = await temporary(t);
  const file = path.join(base, 'model.bin');
  await fs.writeFile(file, 'fixture');
  assert.equal(await assertLocalNoLinks(base, { directory: true }), path.resolve(base));
  assert.equal(await assertLocalNoLinks(file), path.resolve(file));
  const hard = path.join(base, 'hard.bin');
  await fs.link(file, hard);
  await assert.rejects(() => assertLocalNoLinks(hard), (error) => error.code === 'UNSAFE_PATH');
  await assert.rejects(() => assertLocalNoLinks(file), (error) => error.code === 'UNSAFE_PATH');
});

test('local path checks reject junction/symlink ancestors', async (t) => {
  const base = await temporary(t);
  const actual = path.join(base, 'actual');
  const linked = path.join(base, 'linked');
  await fs.mkdir(actual);
  await fs.writeFile(path.join(actual, 'model.bin'), 'fixture');
  try { await fs.symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host cannot create a link fixture.'); return; } throw error; }
  await assert.rejects(() => assertLocalNoLinks(path.join(linked, 'model.bin')), (error) => error.code === 'UNSAFE_PATH');
});
