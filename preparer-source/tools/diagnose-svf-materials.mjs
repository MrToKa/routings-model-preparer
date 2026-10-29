import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { createDecipheriv, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

export function summarizeMaterialDocument(value, imageReferences = []) {
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const keys = v => object(v) ? Object.keys(v).map(k => /^[A-Za-z0-9_. -]{1,80}$/.test(k) ? k : '<other-key>').sort().slice(0, 32) : [];
  const unique = entries => [...new Map(entries.map(v => [JSON.stringify(v), v])).values()].slice(0, 16);
  const shape = v => v === null ? 'null' : Array.isArray(v) ? { array: v.length, itemTypes: [...new Set(v.map(x => x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x))] } : object(v) ? { objectKeys: keys(v) } : typeof v;
  const groups = object(value?.materials) ? Object.values(value.materials) : [];
  const nodes = groups.flatMap(g => object(g?.materials) ? Object.values(g.materials) : []);
  const textures = nodes.flatMap(n => object(n?.textures) ? Object.values(n.textures) : []);
  const refs = new Set(imageReferences), basenames = new Set(imageReferences.map(v => v.split('/').at(-1)));
  let visited = 0, declaredImageStrings = 0, imageBasenameStrings = 0, externalStrings = 0, unmatchedRasterStrings = 0;
  function walk(v) {
    if (++visited > 200000) return;
    if (typeof v === 'string') {
      if (refs.has(v)) declaredImageStrings++;
      else if (basenames.has(v)) imageBasenameStrings++;
      else if (/^(?:https?|file|ftp):|^\/\//i.test(v)) externalStrings++;
      else if (/\.(?:png|jpe?g)(?:[?#].*)?$/i.test(v)) unmatchedRasterStrings++;
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (object(v)) Object.values(v).forEach(walk);
  }
  walk(value);
  return {
    rootKeys: keys(value), name: typeof value?.name === 'string' && /^LMVTK[A-Za-z0-9 ._-]{0,74}$/.test(value.name) ? value.name : '<other>',
    version: typeof value?.version === 'string' && /^[0-9.]{1,16}$/.test(value.version) ? value.version : typeof value?.version,
    sceneKeys: keys(value?.scene), groupCount: groups.length, groupKeySets: unique(groups.map(keys)),
    nodeCount: nodes.length, nodeKeySets: unique(nodes.map(keys)),
    definitions: [...new Set(nodes.map(n => typeof n?.definition === 'string' && /^[A-Za-z0-9_. -]{1,80}$/.test(n.definition) ? n.definition : '<other>'))].slice(0, 32),
    propertyCategories: [...new Set(nodes.flatMap(n => keys(n?.properties)))].sort(),
    uriPropertyNames: [...new Set(nodes.flatMap(n => keys(n?.properties?.uris)))].slice(0, 32),
    referencePropertyNames: [...new Set(nodes.flatMap(n => keys(n?.properties?.references)))].slice(0, 32),
    uriPropertyShapes: unique(nodes.flatMap(n => object(n?.properties?.uris) ? Object.values(n.properties.uris).map(shape) : [])),
    nonEmptyTextureMaps: nodes.filter(n => object(n?.textures) && Object.keys(n.textures).length > 0).length,
    textureValueShapes: unique(textures.map(shape)),
    declaredImageStrings, imageBasenameStrings, externalStrings, unmatchedRasterStrings, traversalTruncated: visited > 200000,
  };
}


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
// Only the two declared material files are read; all other resource bodies are skipped.
export async function diagnoseSVFMaterials({ submissionIdentity, env = process.env, preparerDirectory = process.cwd(), request = nativeRead, emit = value => console.log(JSON.stringify(value)) } = {}) {
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
  let httpRequests = 0, report, imageReferences = [];
  const provider = createAPSProvider({ ...settings, namespace, reuseOnly: true, authorizeRead: async () => {},
    testTransport: { request: async input => {
      const url = new URL(input.url);
      if (++httpRequests > 16 || !(input.method === 'GET' || input.method === 'POST' && url.origin === 'https://developer.api.autodesk.com' && url.pathname === '/authentication/v2/token')) fail('DIAGNOSTIC_READ_ONLY');
      return request({ ...input, signal });
    } }, packageApi: { ...packageApi, DEFAULT_LIMITS: { ...packageApi.DEFAULT_LIMITS, maxNestedBytes: 1024 ** 2 },
      inspectSvfEnvelope: async raw => {
        const archive = await openZip(raw, { signal, limits: { ...packageApi.DEFAULT_LIMITS, maxNestedBytes: 1024 ** 2, maxMs: 5000 } });
        try {
          const value = parseJson((await archive.read('manifest.json', { maxBytes: 1024 ** 2 })).toString('utf8'));
          if (!Array.isArray(value.assets) || value.assets.length > 10000) fail('DIAGNOSTIC_MANIFEST_INVALID');
          imageReferences = value.assets.filter(a => a?.type === 'Autodesk.CloudPlatform.Image' && typeof a.URI === 'string').map(a => a.URI);
          const materials = value.assets.filter(a => a?.type === 'ProteinMaterials' && ['Materials.json.gz', 'ProteinMaterials.json.gz'].includes(a.URI));
          if (materials.length !== 2 || new Set(materials.map(a => a.URI)).size !== 2) fail('DIAGNOSTIC_MATERIALS_MISSING');
          report = { event: 'svf-materials-diagnostic', operationId: selected.row.id, submissionIdentity, svfBytes: raw.length,
            materials: materials.map(a => ({ basename: a.URI, declaredBytes: a.size, declaredInflatedBytes: a.usize })) };
          return { supportProfile: selected.context.supportProfile, resourceClosureVerified: false,
            resources: materials.map(a => ({ path: 'output/0/' + a.URI, bytes: a.size, assetType: a.type })) };
        } finally { await archive.close(); }
      } } });
  const plan = await provider.getDownloadPlan(selected.context, { rootId: selected.row.stage.slice('download-'.length), signal });
  if (!report) fail('DIAGNOSTIC_MANIFEST_INVALID');
  for (const row of report.materials) {
    const resource = plan.resources.find(r => r.path === 'output/0/' + row.basename);
    if (!resource || resource.bytes > 1024 ** 2) fail('DIAGNOSTIC_MATERIALS_LIMIT');
    const chunks = []; let bytes = 0;
    for await (const chunk of provider.readResource(selected.context, { resourceId: resource.resourceId, signal })) {
      bytes += chunk.length; if (bytes > 1024 ** 2) fail('DIAGNOSTIC_MATERIALS_LIMIT'); chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks, bytes);
    const inflated = gunzipSync(raw, { maxOutputLength: 16 * 1024 ** 2 });
    let text, encoding = 'utf-8';
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(inflated); }
    catch { text = inflated.toString('latin1'); encoding = 'latin1'; }
    const document = parseJson(text, { maxDepth: 32 });
    Object.assign(row, { rawBytes: raw.length, inflatedBytes: inflated.length, encoding, structure: summarizeMaterialDocument(document, imageReferences) });
  }
  controller.abort();
  emit({ ...report, httpRequests });
  return report;
}

if (process.argv[1] === '-' || process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  diagnoseSVFMaterials({ submissionIdentity: process.argv[2] }).catch(error => {
    const known = ['DIAGNOSTIC_ID_REQUIRED', 'DIAGNOSTIC_CONFIG_REQUIRED', 'DIAGNOSTIC_FILE_INVALID', 'DIAGNOSTIC_SETTINGS_INVALID',
      'DIAGNOSTIC_OPERATION_LIMIT', 'DIAGNOSTIC_FAILED_DOWNLOAD_NOT_FOUND', 'DIAGNOSTIC_READ_ONLY', 'DIAGNOSTIC_HTTP_FAILED',
      'DIAGNOSTIC_MATERIALS_MISSING', 'DIAGNOSTIC_MATERIALS_LIMIT', 'DIAGNOSTIC_MANIFEST_INVALID', 'INVALID_MANIFEST', 'IDENTITY_MISMATCH', 'DERIVATIVE_PENDING', 'DERIVATIVE_FAILED', 'DERIVATIVE_AMBIGUOUS', 'PACKAGE_LIMIT_EXCEEDED'];
    console.error(JSON.stringify({ event: 'svf-materials-diagnostic-failed', code: known.includes(error?.code) ? error.code : 'DIAGNOSTIC_FAILED' }));
    process.exitCode = 1;
  });
}
