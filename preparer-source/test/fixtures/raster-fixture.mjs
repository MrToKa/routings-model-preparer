import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { openZip, writeZip } from '../../../routings-model-package/lib/zip.mjs';

export async function addRasterResource(data, directory, uri = 'Texture Folder/Fixture Logo.png') {
  function chunk(type, data) {
    const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); result.write(type, 4, 'ascii'); data.copy(result, 8);
    result.writeUInt32BE(crc32(result.subarray(4, result.length - 4)), result.length - 4); return result;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  const image = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0,255,0,0,255]))), chunk('IEND', Buffer.alloc(0))]);
  const archive = await openZip(data.get('output/0/0.svf'));
  let manifest, metadata;
  try { manifest = JSON.parse(await archive.read('manifest.json')); metadata = await archive.read('metadata.json'); }
  finally { await archive.close(); }
  manifest.assets.unshift({ id: 'nested-raster', type: 'Autodesk.CloudPlatform.Image', URI: uri, size: image.length, usize: image.length });
  const filename = path.join(directory, randomUUID() + '.svf');
  await writeZip(filename, [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, { name: 'metadata.json', data: metadata }]);
  const svf = await fs.readFile(filename), imagePath = 'output/0/' + uri;
  data.set('output/0/0.svf', svf); data.set(imagePath, image);
  return { image, imagePath, svf };
}
