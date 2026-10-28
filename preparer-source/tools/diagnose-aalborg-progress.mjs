import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// Pipe to the existing container with --workdir /opt/preparer. Read-only local
// snapshots, 15 seconds apart while running; no API calls, locks or state writes.
const { digest } = await import(pathToFileURL(path.resolve('lib/contracts.mjs')));
const data = process.env.PREPARER_DATA_DIR;
const operations = path.join(data, 'workspace-journal', 'operations');
const core = path.join(data, 'live', 'core');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));
async function record(kind, key) {
  try {
    const h = await json(path.join(core, 'heads', digest({ kind, key }) + '.json'));
    const { checksum, ...headBody } = h;
    if (h.kind !== kind || h.key !== key || digest(headBody) !== checksum) throw Error('HEAD_CHECKSUM_MISMATCH');
    if (!Number.isSafeInteger(h.revision) || h.revision < 1) return null;
    const r = await json(path.join(core, 'records', kind, key, String(h.revision).padStart(16, '0') + '.json'));
    const { recordHash, ...body } = r;
    if (recordHash !== h.recordHash || digest(body) !== recordHash) throw Error('CHECKSUM_MISMATCH');
    return { value: r.value, at: r.committedAt };
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
const rows = [];
for (const name of await fs.readdir(operations)) {
  if (name.endsWith('.json') && uuid.test(name.slice(0, -5))) {
    const r = (await json(path.join(operations, name))).value;
    if (/aalborg/i.test(r.label || '') && r.id === name.slice(0, -5) && uuid.test(r.jobId || '')) rows.push(r);
  }
}
rows.sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || String(b.updatedAt).localeCompare(String(a.updatedAt)));
if (!rows.length) throw Error('AALBORG_OPERATION_NOT_FOUND');
const selected = rows[0];
const samples = selected.status === 'running' ? 2 : 1;
for (let sample = 1; sample <= samples; sample++) {
  const op = (await json(path.join(operations, selected.id + '.json'))).value;
  const j = (await record('job', selected.jobId))?.value;
  const key = j?.frozen && digest({ kind: 'engineer-declared-local-budget', submissionIdentity: j.frozen.submissionIdentity });
  const budget = key ? await record('cost', key) : null;
  const checkpoints = Object.values(j?.download?.checkpoints || {}), partialFiles = [];
  if (j?.download?.modelDirectory) {
    const parts = path.join(path.dirname(j.download.modelDirectory), 'parts');
    try { for (const name of await fs.readdir(parts)) {
      if (!/^resource-[0-9a-f-]+\.part$/.test(name)) continue;
      try { const s = await fs.stat(path.join(parts, name)); partialFiles.push({ bytes: s.size, modifiedAt: s.mtime.toISOString() }); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    } } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  console.log(JSON.stringify({ sample, at: new Date().toISOString(), model: op.label, id: op.id, status: op.status, stage: op.stage,
    jobStatus: j?.status, operationError: op.error, jobError: j?.error, downloadStatus: j?.download?.status, jobUpdatedAt: j?.updatedAt,
    completedResources: checkpoints.length, completedMiB: Math.round(checkpoints.reduce((n, c) => n + c.bytes, 0) / 104857.6) / 10,
    readReservations: budget?.value?.reads, lastReadReservationAt: budget?.at, partialFiles }));
  if (sample < samples) await new Promise(resolve => setTimeout(resolve, 15000));
}
