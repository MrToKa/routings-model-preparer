import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreError } from '../index.mjs';
import { safeError, ServiceError } from '../app/errors.mjs';

for (const code of ['COST_UNVERIFIABLE', 'COST_UNKNOWN', 'COST_IDENTITY_MISMATCH']) {
  for (const [kind, factory] of [['core', () => new CoreError(code, 'https://private.invalid/?access_token=never-expose')], ['service', () => new ServiceError(code)]]) {
    test(kind + ' authorization failure preserves its actionable code without private error text: ' + code, () => {
      const result = safeError(factory());
      assert.equal(result.code, code);
      assert.equal(typeof result.message, 'string');
      assert.ok(result.message.length > 0);
      assert.doesNotMatch(result.message, /private.invalid|access_token|never-expose/);
    });
  }
}
test('a foreign object cannot impersonate a trusted authorization failure', () => {
  const result = safeError({ code: 'COST_UNVERIFIABLE', message: 'private provider message' });
  assert.equal(result.code, 'PROVIDER_FAILURE');
  assert.doesNotMatch(result.message, /private provider/);
});
