#!/usr/bin/env node
import { packModel, verifyPackage, PackageError } from './index.mjs';
import { writeJsonAtomic } from './lib/io.mjs';
import { contained } from './lib/io.mjs';
import path from 'node:path';

const HELP = `Routings model package 1.0.0 (Node.js 24; no dependencies/network)
  node cli.mjs pack --model-dir DIR --source NWD --output ZIP --label TEXT
       [--package-id UUID] [--prepared-at UTC] [--expect-fingerprint HEX]
       [--manifest FILE] [--report FILE] [--recover]
  node cli.mjs verify --package ZIP [--expect-fingerprint HEX]
       [--report FILE] [--extract-to NEW_DIRECTORY]
  node --test test/*.test.mjs
Exit: 0 PASS, 1 validation/I/O/publication failure, 2 usage/Node version,
      130 interrupted/cancelled. No overwrite of an existing package.
`;

const switches = new Set(['model-dir', 'source', 'output', 'label', 'package-id', 'prepared-at', 'expect-fingerprint', 'manifest', 'report', 'package', 'extract-to']);
const values = {};
const [command, ...args] = process.argv.slice(2);
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
try {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Node.js 24 is required.');
  if (!command || command === '--help' || command === 'help') { console.log(HELP); process.exitCode = 0; }
  else {
    for (let index = 0; index < args.length; index++) {
      const flag = args[index];
      if (flag === '--recover') { if (values.recover) throw new Error('Duplicate --recover.'); values.recover = true; continue; }
      const name = flag.slice(2);
      if (!flag.startsWith('--') || !switches.has(name) || values[name] !== undefined || args[index + 1] === undefined || args[index + 1].startsWith('--')) throw new Error(`Invalid, duplicate or missing argument: ${flag}`);
      values[name] = args[++index];
    }
    let report;
    if (command === 'pack') {
      for (const name of ['model-dir', 'source', 'output', 'label']) if (!values[name]) throw new Error(`Missing --${name}.`);
      if (values.package || values['extract-to']) throw new Error('Verify-only arguments cannot be used with pack.');
      report = await packModel({ modelDir: values['model-dir'], source: values.source, output: values.output, label: values.label,
        packageId: values['package-id'], preparedAt: values['prepared-at'], expectedFingerprint: values['expect-fingerprint'],
        manifest: values.manifest, report: values.report, recover: values.recover, signal: controller.signal });
    } else if (command === 'verify') {
      if (!values.package) throw new Error('Missing --package.');
      for (const name of ['model-dir', 'source', 'output', 'label', 'package-id', 'prepared-at', 'manifest', 'recover']) if (values[name]) throw new Error(`Pack-only argument --${name}.`);
      report = await verifyPackage(values.package, { expectedFingerprint: values['expect-fingerprint'], extractTo: values['extract-to'], signal: controller.signal });
      if (values.report) await writeJsonAtomic(values.report, report, { replace: false });
    } else throw new Error(`Unknown command: ${command}`);
    console.log(JSON.stringify({ status: report.status, package: report.package, contentFingerprint: report.contentFingerprint,
      resourceCount: report.resourceCount, totalRawBytes: report.totalRawBytes, report: values.report ?? report.publication?.reportPath ?? null }, null, 2));
  }
} catch (error) {
  const isUsage = !(error instanceof PackageError) && !error.code;
  const code = error.code ?? (isUsage ? 'USAGE' : 'IO_ERROR');
  const result = { reportSchemaVersion: 1, toolVersion: '1.0.0', nodeVersion: process.version, operation: command,
    status: 'FAIL', checkedAt: new Date().toISOString(), error: { code, message: error.message, details: error.details ?? {} } };
  // Failure reporting never overwrites package input or an existing good report.
  const protectedPaths = [values.package, values.output, values.source, values.manifest].filter(Boolean).map(file => path.resolve(file).toLowerCase());
  const forbiddenRoots = [values['model-dir'], values.source ? path.dirname(path.resolve(values.source)) : null].filter(Boolean);
  if (values.report && !protectedPaths.includes(path.resolve(values.report).toLowerCase()) && !forbiddenRoots.some(root => contained(root, values.report))) {
    try { await writeJsonAtomic(values.report, result, { forbiddenRoots }); } catch { /* primary error remains authoritative */ }
  }
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = code === 'PACKAGE_ABORTED' || controller.signal.aborted ? 130 : isUsage ? 2 : 1;
}
