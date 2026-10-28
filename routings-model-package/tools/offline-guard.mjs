// Verification instrumentation, not a runtime dependency. It blocks networking,
// .env reads and optionally explicitly forbidden input directories. Reports are
// local files selected in this module's import URL; it never reads environment.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const settings = new URL(import.meta.url).searchParams;
const reportPath = settings.get('report');
const forbidden = settings.getAll('forbid').map(value => path.resolve(value).toLowerCase());
const audit = { reportSchemaVersion: 1, operation: 'offline-guard', startedAt: new Date().toISOString(), nodeVersion: process.version,
  status: 'PASS', networkAttempts: [], forbiddenReadAttempts: [], readPaths: [], forbiddenRoots: forbidden };
const seen = new Set();
function blockNetwork(api) {
  return function () { audit.status = 'FAIL'; audit.networkAttempts.push({ api }); const error = new Error(`Network API prohibited by offline verification: ${api}`); error.code = 'NETWORK_FORBIDDEN'; throw error; };
}
globalThis.fetch = blockNetwork('fetch');
for (const [target, names, label] of [[http, ['request', 'get'], 'http'], [https, ['request', 'get'], 'https'], [net, ['connect', 'createConnection'], 'net'], [tls, ['connect'], 'tls'], [dgram, ['createSocket'], 'dgram']]) {
  for (const name of names) target[name] = blockNetwork(`${label}.${name}`);
}
net.Socket.prototype.connect = blockNetwork('Socket.connect');
function inspect(candidate, operation) {
  if (typeof candidate === 'number' || candidate === null || candidate === undefined) return;
  const value = candidate instanceof URL ? fileURLToPath(candidate) : Buffer.isBuffer(candidate) ? candidate.toString() : String(candidate);
  const resolved = path.resolve(value), lower = resolved.toLowerCase();
  if (path.basename(lower).startsWith('.env') || forbidden.some(root => lower === root || lower.startsWith(root + path.sep))) {
    audit.status = 'FAIL'; audit.forbiddenReadAttempts.push({ operation, path: resolved });
    const error = new Error('File read prohibited by offline verification.'); error.code = 'OFFLINE_INPUT_FORBIDDEN'; throw error;
  }
  if (!seen.has(resolved)) { seen.add(resolved); audit.readPaths.push(resolved); }
}
for (const name of ['open', 'readFile', 'readdir', 'stat', 'lstat', 'realpath', 'access']) {
  const original = fsp[name];
  fsp[name] = function (candidate, ...args) { inspect(candidate, `fs.promises.${name}`); return original.call(this, candidate, ...args); };
}
for (const name of ['open', 'openSync', 'readFile', 'readFileSync', 'readdir', 'readdirSync', 'stat', 'statSync', 'lstat', 'lstatSync', 'realpath', 'realpathSync', 'access', 'accessSync', 'createReadStream']) {
  const original = fs[name];
  fs[name] = function (candidate, ...args) { inspect(candidate, `fs.${name}`); return original.call(this, candidate, ...args); };
}
syncBuiltinESMExports();
process.on('exit', exitCode => {
  audit.finishedAt = new Date().toISOString(); audit.exitCode = exitCode;
  if (exitCode !== 0) audit.status = 'FAIL';
  if (reportPath) fs.writeFileSync(path.resolve(reportPath), JSON.stringify(audit, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
});
