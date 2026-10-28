import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { writeZip, openZip } from '../lib/zip.mjs';

export async function localModel(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'routings-package-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const modelDir = path.join(root, 'model');
  const sourceDir = path.join(root, 'source');
  const outputDir = path.join(root, 'artifacts');
  await fs.mkdir(path.join(modelDir, 'output', '0'), { recursive: true });
  await fs.mkdir(sourceDir); await fs.mkdir(outputDir);
  const source = path.join(sourceDir, 'fixture.nwd');
  const sourceBytes = Buffer.from('metadata-only NWD fixture\n');
  await fs.writeFile(source, sourceBytes);
  const data = new Map([
    ['0.pf', gzipSync(Buffer.from('Opaque geometry fixture\n'))],
    ['Materials.json.gz', gzipSync(Buffer.from(JSON.stringify({ name: 'LMVTK Simple Materials', version: '1.0', scene: { SceneUnit: 8193, YIsUp: 0 }, materials: {} })))],
    ['properties.db', Buffer.from('SQLite format 3\0opaque fixture\n')],
  ]);
  const metaBytes = Buffer.from('{"version":"1.0","metadata":{}}');
  const svf = { name: 'LMV Manifest', toolkitversion: 'LMVTK 5.0.26.0', manifestversion: 2,
    adskID: { sourceSystem: '', type: '', id: '', version: '' },
    assets: [
      { id: '0.pf', type: 'Autodesk.CloudPlatform.PackFile', URI: '0.pf', size: data.get('0.pf').length, usize: 0, typeset: '2' },
      { id: 'Materials.json.gz', type: 'ProteinMaterials', URI: 'Materials.json.gz', size: data.get('Materials.json.gz').length, usize: 0 },
      { id: 'metadata.json', type: 'Autodesk.CloudPlatform.ViewingMetadata', URI: 'embed:/metadata.json', size: metaBytes.length, usize: metaBytes.length },
    ], typesets: [{ id: '2', types: [{ class: 'Autodesk.CloudPlatform.Geometry', type: 'Autodesk.CloudPlatform.OpenCTM', version: 1 }] }],
  };
  const svfPath = path.join(modelDir, 'output', '0', '0.svf');
  await writeZip(svfPath, [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(svf)) }, { name: 'metadata.json', data: metaBytes }]);
  data.set('0.svf', await fs.readFile(svfPath));
  for (const [name, bytes] of data) if (name !== '0.svf') await fs.writeFile(path.join(modelDir, 'output', '0', name), bytes);
  const integrity = {};
  for (const [name, bytes] of data) integrity[`output/0/${name}`] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), transport: 'raw-http-v1' };
  await fs.writeFile(path.join(modelDir, 'integrity.json'), JSON.stringify(integrity));
  await fs.writeFile(path.join(modelDir, 'model.json'), JSON.stringify({ name: 'fixture.nwd', format: 'svf', entrypoint: '/model/output/0/0.svf', viewerVersion: '7.130.0', sourceBytes: sourceBytes.length, resourceCount: data.size, totalBytes: [...data.values()].reduce((sum, bytes) => sum + bytes.length, 0) }));
  const output = path.join(outputDir, 'fixture.zip');
  return { root, modelDir, source, output, data, options: { modelDir, source, output, label: 'Tiny offline fixture', packageId: '391332e6-d7b7-4fa8-bcc7-f8c656804049', preparedAt: '2026-10-16T08:00:00.000Z' } };
}

export async function archiveEntries(file) {
  const archive = await openZip(file);
  try {
    const entries = [];
    for (const entry of archive.entries.values()) if (!entry.isDirectory) entries.push({ name: entry.name, data: await archive.read(entry.name) });
    return entries;
  } finally { await archive.close(); }
}
