import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { packModel, verifyPackage } from '../index.mjs';
import { localModel } from './fixtures.mjs';

for (const toolkitVersion of ['LMVTK 5.0.26.0', 'LMVTK 5.0.43.0']) {
  test('portable package roundtrip preserves ' + toolkitVersion + ' resources', async t => {
    const f = await localModel(t, { toolkitVersion });
    const packed = await packModel(f.options);
    const verified = await verifyPackage(f.output, { extractTo: path.join(f.root, 'extracted'), expectedFingerprint: packed.contentFingerprint });
    assert.equal(packed.status, 'PASS');
    assert.equal(verified.status, 'PASS');
    assert.equal(verified.resourceCount, 4);
    assert.equal(verified.extraction.hashesCompared, 4);
    for (const [name, bytes] of f.data) {
      assert.deepEqual(await fs.readFile(path.join(f.root, 'extracted', 'resources', 'output', '0', name)), bytes);
    }
  });
}
