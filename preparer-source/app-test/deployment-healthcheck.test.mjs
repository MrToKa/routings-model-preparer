import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const dockerfile = await fs.readFile(new URL('../deployment/Dockerfile', import.meta.url), 'utf8');
const command = dockerfile.split('\n').find(line => line.startsWith('HEALTHCHECK '))?.match(/CMD node -e "(.*)"$/)?.[1];
assert.ok(command, 'Dockerfile must contain the Node health command');
for (const [name, origin, status, reject, expected] of [
  ['LAN origin', 'http://192.168.5.55:8083', 200, false, 0],
  ['loopback public origin', 'http://127.0.0.1:8083', 200, false, 0],
  ['default container origin', undefined, 200, false, 0],
  ['HTTP rejection', 'http://192.168.5.55:8083', 403, false, 1],
  ['network failure', 'http://192.168.5.55:8083', 0, true, 1],
]) {
  test('Docker healthcheck: ' + name, async () => {
    let request, exitCode;
    const errors = [];
    await vm.runInNewContext(command, {
      URL, AbortSignal,
      process: {env: origin ? {PREPARER_PUBLIC_ORIGIN: origin} : {}, exit: value => { exitCode = value; }},
      console: {error: value => errors.push(value)},
      fetch: async (url, options) => {
        request = {url, options};
        if (reject) throw new Error('network');
        return {ok: status === 200, status};
      },
    });
    assert.equal(request.url, 'http://127.0.0.1:8080/health');
    assert.equal(request.options.headers.Host, new URL(origin || 'http://127.0.0.1:8080').host);
    assert.ok(request.options.signal);
    assert.equal(exitCode, expected);
    assert.equal(errors.length, expected);
  });
}
