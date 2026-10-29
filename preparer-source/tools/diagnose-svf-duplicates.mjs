import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { createDecipheriv, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => { const error = new Error(code); error.code = code; throw error; };

async function boundedFile(filename, maxBytes) {
  const info = await fs.lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) fail('DIAGNOSTIC_FILE_INVALID');
  const bytes = await fs.readFile(filename);
  if (bytes.length > maxBytes) fail('DIAGNOSTIC_FILE_INVALID');
  return bytes;
}
async function privateSettings(directory, origin) {
  const key = await boundedFile(path.join(directory, 'workspace.key'), 32);
  if (key.length !== 32) fail('DIAGNOSTIC_SETTINGS_INVALID');
  const envelope = JSON.parse(await boundedFile(path.join(directory, 'workspace.enc'), 2 * 1024 ** 2));
  if (envelope.schemaVersion !== 1) fail('DIAGNOSTIC_SETTINGS_INVALID');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from('routings-model-preparer/workspace-security/v1/' + origin));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]));
  if (state.schemaVersion !== 1 || state.wfcOrigin !== origin || state.settings?.enabled !== true) fail('DIAGNOSTIC_SETTINGS_INVALID');
  const { clientId, clientSecret, bucket, region } = state.settings;
  return { clientId, clientSecret, bucket, region };
}
async function nativeRead(input) {
  return new Promise((resolve, reject) => {
    const request = https.request(input.url, { method: input.method, headers: input.headers, signal: input.signal }, response => {
      resolve({ statusCode: response.statusCode, headers: response.headers, body: response });
    });
    request.setTimeout(15000, () => request.destroy(new Error('DIAGNOSTIC_TIMEOUT')));
    request.once('error', () => reject(Object.assign(new Error('DIAGNOSTIC_HTTP_FAILED'), { code: 'DIAGNOSTIC_HTTP_FAILED' })));
    request.end(input.body);
  });
}

// Run separately from the service: no store initialization writes, locks,
// checkpoints, settings changes or data mutation endpoints are permitted.
export async function diagnoseSVFDuplicates({ submissionIdentity, env = process.env, preparerDirectory = process.cwd(), request = nativeRead, emit = value => console.log(JSON.stringify(value)) } = {}) {
  if (!HASH.test(submissionIdentity ?? '')) fail('DIAGNOSTIC_ID_REQUIRED');
  const data = env.PREPARER_DATA_DIR, work = env.PREPARER_WORK_DIR, modulePath = env.PREPARER_PACKAGE_MODULE;
  if (![data, work, modulePath].every(value => typeof value === 'string' && path.isAbsolute(value))) fail('DIAGNOSTIC_CONFIG_REQUIRED');
  const { createStore } = await import(pathToFileURL(path.join(preparerDirectory, 'lib/store.mjs')));
  const { createAPSProvider } = await import(pathToFileURL(path.join(preparerDirectory, 'lib/aps-provider.mjs')));
  const packageApi = await import(pathToFileURL(modulePath));
  const { openZip } = await import(pathToFileURL(path.join(path.dirname(modulePath), 'lib/zip.mjs')));
  const { parseJson } = await import(pathToFileURL(path.join(path.dirname(modulePath), 'lib/json.mjs')));
  const store = createStore({ dataDirectory: path.join(data, 'live/core'), workDirectory: path.join(work, 'live/core-work'), readOnly: true });
  await store.init();
  const operations = path.join(data, 'workspace-journal/operations');
  const names = (await fs.readdir(operations)).filter(name => UUID.test(name.replace(/\.json$/, '')) && name.endsWith('.json'));
  if (names.length > 1000) fail('DIAGNOSTIC_OPERATION_LIMIT');
  const rows = [];
  for (const name of names) {
    const row = JSON.parse(await boundedFile(path.join(operations, name), 4 * 1024 ** 2)).value;
    if (row?.status === 'failed' && UUID.test(row.jobId ?? '') && /^download-aps-root-[0-9a-f]{64}$/.test(row.stage ?? '')) rows.push(row);
  }
  rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  let selected;
  for (const row of rows.slice(0, 50)) {
    const job = await store.read('job', row.jobId);
    if (job?.frozen?.submissionIdentity === submissionIdentity) { selected = { row, context: job.frozen }; break; }
  }
  if (!selected) fail('DIAGNOSTIC_FAILED_DOWNLOAD_NOT_FOUND');
  const settings = await privateSettings(path.join(data, 'workspace-private'), new URL(env.PREPARER_WFC_ORIGIN).origin);
  const namespace = { account: 'team-' + digest('aps-account:' + settings.clientId), application: 'app-' + digest(settings.clientId) };
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
  let httpRequests = 0, report;
  const provider = createAPSProvider({ ...settings, namespace, reuseOnly: true, authorizeRead: async () => {},
    testTransport: { request: async input => {
      const url = new URL(input.url);
      if (++httpRequests > 8 || !(input.method === 'GET' || input.method === 'POST' && url.origin === 'https://developer.api.autodesk.com' && url.pathname === '/authentication/v2/token')) fail('DIAGNOSTIC_READ_ONLY');
      return request({ ...input, signal });
    } }, packageApi: { ...packageApi, DEFAULT_LIMITS: { ...packageApi.DEFAULT_LIMITS, maxNestedBytes: 1024 ** 2 },
      inspectSvfEnvelope: async raw => {
        const archive = await openZip(raw, { signal, limits: { ...packageApi.DEFAULT_LIMITS, maxNestedBytes: 1024 ** 2, maxMs: 5000 } });
        try {
          const duplicates = [];
          const knownKeys = new Set(['metadata', 'name', 'version', 'assets', 'typesets', 'id', 'type', 'URI', 'size', 'usize',
            'toolkitversion', 'manifestversion', 'adskID', 'sourceSystem', 'default display unit', 'distance unit', 'value',
            'world bounding box', 'minXYZ', 'maxXYZ', 'world up vector', 'world front vector', 'world north vector', 'XYZ']);
          const units = new Set(['m', 'mm', 'cm', 'dm', 'km', 'ft', 'in', 'yd']);
          const canonical = v => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v)
            ? '[' + v.map(canonical).join(',') + ']' : '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
          for (const entry of ['manifest.json', 'metadata.json']) {
            const bytes = await archive.read(entry, { maxBytes: 1024 ** 2 });
            parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { maxDepth: packageApi.DEFAULT_LIMITS.maxDepth,
              allowDuplicate: ({ path: location, key, previous, value }) => {
                if (duplicates.length >= 64) fail('DIAGNOSTIC_DUPLICATE_LIMIT');
                const unit = v => v && !Array.isArray(v) && Object.keys(v).length === 1 && units.has(v.value) ? v.value : null;
                duplicates.push({ entry, key: knownKeys.has(key) ? key : '<other-key>',
                  keyFingerprint: digest(key).slice(0, 12), depth: location.split(/[.\[]/).length - 1,
                  equalValues: canonical(previous) === canonical(value),
                  previousType: previous === null ? 'null' : Array.isArray(previous) ? 'array' : typeof previous,
                  nextType: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
                  previousUnit: unit(previous), nextUnit: unit(value) });
                return true; // Diagnosis only; the service's strict parser is unchanged.
              } });
          }
          report = { event: 'svf-duplicate-key-diagnostic', operationId: selected.row.id, submissionIdentity,
            svfBytes: raw.length, svfSha256: digest(raw), duplicateCount: duplicates.length, duplicates };
        } finally { await archive.close(); }
        controller.abort(); // Stop before signing or downloading any sibling.
        throw new Error('DIAGNOSTIC_COMPLETE');
      } } });
  try { await provider.getDownloadPlan(selected.context, { rootId: selected.row.stage.slice('download-'.length), signal }); }
  catch (error) { if (!report) throw error; }
  if (!report) fail('DIAGNOSTIC_MANIFEST_INVALID');
  emit({ ...report, httpRequests });
  return report;
}

if (process.argv[1] === '-' || process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  diagnoseSVFDuplicates({ submissionIdentity: process.argv[2] }).catch(error => {
    const known = ['DIAGNOSTIC_ID_REQUIRED', 'DIAGNOSTIC_CONFIG_REQUIRED', 'DIAGNOSTIC_FILE_INVALID', 'DIAGNOSTIC_SETTINGS_INVALID',
      'DIAGNOSTIC_OPERATION_LIMIT', 'DIAGNOSTIC_FAILED_DOWNLOAD_NOT_FOUND', 'DIAGNOSTIC_READ_ONLY', 'DIAGNOSTIC_HTTP_FAILED',
      'DIAGNOSTIC_DUPLICATE_LIMIT', 'DIAGNOSTIC_MANIFEST_INVALID', 'IDENTITY_MISMATCH', 'DERIVATIVE_PENDING', 'DERIVATIVE_FAILED', 'DERIVATIVE_AMBIGUOUS', 'PACKAGE_LIMIT_EXCEEDED'];
    console.error(JSON.stringify({ event: 'svf-duplicate-key-diagnostic-failed', code: known.includes(error?.code) ? error.code : 'DIAGNOSTIC_FAILED' }));
    process.exitCode = 1;
  });
}
