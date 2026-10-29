import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source = await fs.readFile(new URL('../web/workspace.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function downloadView('), end = source.indexOf('\nfunction renderGenerations()', start);
const view = vm.runInNewContext(source.slice(start, end) + ';downloadView');
const at = Date.parse('2026-10-29T12:00:00Z');
const base = { status: 'running', phase: 'resource-transfer', completedResources: 10, plannedResources: 20,
  completedBytes: 1048576, plannedBytes: 4194304, currentBytes: 1048576, lastByteAt: new Date(at - 3000).toISOString(), startedAt: new Date(at - 120000).toISOString() };
test('download view uses confirmed and current bytes rather than a fixed stage percentage', () => {
  const result = view(base, at); assert.equal(result.fraction, 0.5); assert.match(result.summary, /10 от 20/); assert.match(result.summary, /MiB/);
  assert.match(result.activity, /Получават се данни/); assert.equal(result.quiet, false);
});
test('stale transfer shows waiting and elapsed time instead of claiming active bytes', () => {
  const result = view({ ...base, lastByteAt: new Date(at - 65000).toISOString() }, at);
  assert.equal(result.quiet, true); assert.match(result.activity, /Изчакване/); assert.match(result.activity, /65 сек/);
});
test('checkpoint checking and commit remain explicit phases', () => {
  assert.match(view({ ...base, phase: 'checkpoint-verification' }, at).activity, /Проверка/);
  assert.match(view({ ...base, phase: 'checkpoint-commit' }, at).activity, /Запис/);
});
test('failed transfer is not displayed as receiving data and a missing plan has no invented percentage', () => {
  assert.match(view({ ...base, status: 'failed' }, at).activity, /не е активно/);
  assert.equal(view({ completedResources: 10, completedBytes: 1048576 }, at).fraction, null);
});
