# Routings model package

Standalone Node.js 24 packager and verifier for portable offline SVF model packages. Stage 1 packages the existing Aalborg model, preserves its raw bytes, and verifies the package without its original input directories.

The tool uses Node built-ins only. Copy this directory to a machine with Node.js **24.x**; no dependency installation, network access, `.env`, APS credentials, Autodesk translation, WFC server, database or SDK installation is needed for packaging or verification. Tested with Node.js **24.19.0**. The directory is a standalone local module, separate from WFC and the working Viewer.

## Commands

Run these commands from the copied module directory. For another working directory, use the absolute path to `cli.mjs`.

```powershell
node --version
node cli.mjs --help
node --test test/*.test.mjs
```

### Create a package

`--model-dir` points to the existing local model directory containing `model.json`, `integrity.json`, and `output/`. The tool checks the legacy descriptor, hashes the entire physical output inventory, compares all integrity records, validates the SVF profile and references, then creates and reopens the ZIP through the verifier. The physical inventory includes `properties.db`; it is not derived only from the SVF asset list.

`--source` is the local NWD reference. It is read for its basename, size and SHA-256, including a readback before publication. It is not uploaded, converted, included in the ZIP or required by the verifier. The manifest records `source.identityBasis = "observed-local-file"`; this does not retrospectively prove that the same NWD bytes were used in the old Autodesk conversion.

```powershell
node cli.mjs pack `
  --model-dir "D:\ModelPreparerConfig\offline\model" `
  --source "D:\SourceModels\Aalborg_ACS_CABLETRAY_30_03_26.nwd" `
  --output "D:\Prepared models\aalborg-svf-v1.zip" `
  --label "Aalborg cable trays — snapshot 30.03.2026" `
  --expect-fingerprint b5bb4fbe666b440c73bb1ffd2ee0db01be66146f8002e4a9df8dce8521db1d34
```

Required arguments: `--model-dir`, `--source`, `--output`, `--label`.

Optional arguments:

| Argument | Behavior |
|---|---|
| `--package-id UUID` | Supplies a canonical lowercase UUIDv4 instead of generating one for the first publication. |
| `--prepared-at UTC` | Supplies an RFC3339 UTC instant ending in `Z`; otherwise the first publication uses the current time. |
| `--expect-fingerprint HEX` | Refuses content that differs from the specified lowercase SHA-256 content fingerprint. |
| `--manifest FILE` | Sidecar manifest path; default is `ZIP.manifest.json`. |
| `--report FILE` | Machine-readable verification report path; default is `ZIP.validation.json`. |
| `--recover` | Allows recovery of a recognized publication lock only when its recorded process is confirmed dead. |

Outputs and staging must be outside the model input directory and the source NWD directory. Sidecars cannot alias the ZIP, source, each other, or reserved lifecycle paths. Use canonical full local paths; conservative link checks reject symlinks, junctions, hardlinked files and resolving aliases such as Windows 8.3 spellings.

### Verify and optionally extract

Verification requires only the received ZIP and this module. It checks the strict portable manifest, archive structure, exact file inventory, raw byte counts and hashes, content fingerprint, supported profile and nested reference closure. It hashes the transport before and after verification and checks file identity to detect changes during the operation.

```powershell
node cli.mjs verify `
  --package "D:\Prepared models\aalborg-svf-v1.zip" `
  --expect-fingerprint b5bb4fbe666b440c73bb1ffd2ee0db01be66146f8002e4a9df8dce8521db1d34 `
  --report "D:\Prepared models\received-verification.json" `
  --extract-to "D:\Prepared models\received-model"
```

`--package` is required. `--expect-fingerprint`, `--report` and `--extract-to` are optional. The report target must be new. The extraction target must be a new isolated directory. Extraction independently compares each resource's bytes/hash and removes its own newly created directory on failure; pre-existing directories are refused.

Without `--report`, the CLI prints a summary to stdout. The JavaScript API returns the complete machine-readable report. Validation and I/O failures produce structured JSON on stderr; when an explicitly requested safe report path is available, the CLI also writes a failure report without replacing an existing file.

| Exit code | Meaning |
|---|---|
| `0` | PASS, or successful help output. |
| `1` | Validation, I/O or publication failure. |
| `2` | Invalid usage or unsupported Node major version. |
| `130` | Interrupted/cancelled operation. |

## Publication and retry

The tool reserves `packageId` and `preparedAt` in `ZIP.publication.json`. Retry must preserve that identity and the recorded content/source/label; a conflicting reservation or existing ZIP is refused. Successful retry keeps the archive bytes unchanged. An existing validation report can be refreshed only when it identifies the same successful package and transport hash; an unrelated file is preserved.

Each output uses `ZIP.lock` plus the exclusive lifecycle directory `ZIP.lock.mutex`. Acquisition/recovery/release is serialized, and release verifies lock ownership with a nonce and file identity. A live owner is never recovered. A mutex left by an abrupt interruption requires manual inspection; `--recover` does not automatically delete it.

The ZIP is written in a sibling `.routings-stage-*` directory, verified, and published using an atomic no-overwrite hardlink operation. The filesystem must support hardlinks on that volume. A failure leaves any previous good ZIP intact and retains the identity reservation when retry is needed. Normal completion/failure cleans up the tool's staging and owned lock. These checks do not claim protection against an adversarial process concurrently rewriting the filesystem, or guaranteed durability after a power failure.

## Package contract

```text
manifest.json
resources/output/0/0.svf
resources/output/0/...
resources/output/0/properties.db
```

The portable manifest schema is [schemas/portable-manifest-v1.schema.json](schemas/portable-manifest-v1.schema.json). Runtime validators supplement JSON Schema: duplicate decoded keys, published ordinal ordering, safe paths/case collisions, real calendar dates, actual stream counters, hashes and profile/reference checks require executable validation.

All root fields are required: `schemaVersion`, `packageId`, `label`, `source`, `preparedAt`, `supportProfile`, `format`, `sdkVersion`, `entrypoint`, `resources`, `contentFingerprint`. Source contains `name`, `bytes`, `sha256`, `identityBasis`; every resource contains `path`, `bytes`, `sha256`. Portable JSON rejects unknown fields, malformed UTF-8 and duplicate keys, including escaped equivalent keys.

Fixed v1 profile:

| Field | Value |
|---|---|
| `schemaVersion` | `1` |
| `supportProfile` | `svf-local-7.130.0-v1` |
| `format` | `svf` |
| `sdkVersion` | `7.130.0` |
| `entrypoint` | `resources/output/0/0.svf` |
| Embedded SVF manifest | `manifestversion = 2`, `toolkitversion = "LMVTK 5.0.26.0"` or `"LMVTK 5.0.43.0"` |

The supported profile validates its known asset types/typeset tuples, embedded `metadata.json`, recognized gzip JSON structures and exact declared resource closure. Material assets may include both `Materials.json.gz` (LMVTK Simple Materials 1.0) and its supplemental `ProteinMaterials.json.gz` (LMVTK Protein Materials 1.0). Active SimplePhong texture slots connect to one local UnifiedBitmap, whose URI must resolve to a declared PNG/JPEG asset by ID or exact relative URI. Nested raster paths may contain bounded ASCII spaces. Unknown definitions, texture slots, graph targets, cycles, external active texture addresses and undeclared images are rejected. Raw material, SVF and image bytes remain unchanged.

The supplemental Protein document permits the observed typed SimplePhong, Generic and UnifiedBitmap catalog records. In Viewer 7.130.0 only Prism definitions select a Protein group for rendering; this profile rejects those definitions. Catalog thumbnails and bitmap strings are therefore inert metadata and do not require additional image downloads. The Simple Materials bitmap references are verified independently.

The sole duplicate-key exception permits one identical pair of `metadata["default display unit"]` records containing only `{"value":"m"}` or only `{"value":"mm"}`. Mixed units, a third occurrence and other duplicate keys remain invalid. Conflicting duplicates and reference-bearing duplicates are rejected. Positive declared inflated sizes must match; a property declaration with `usize: 0` leaves that assertion unspecified while actual inflation limits are still enforced.

Raw gzip bytes remain unchanged even when a `.pf`, `.bin` or `.pack` file is internally compressed. Raw hashes, raw asset sizes, ZIP compressed sizes and declared inflated sizes are checked in their separate scopes. Property text containing a URL is inert data, not automatically a loader reference.

The ZIP contains no NWD, runtime/SDK, application code, state, credentials, WFC project/user identifiers, README or validation report. SDK/runtime delivery is a separate trusted offline operation. The verifier does not perform a semantic audit or execution of arbitrary SQLite or PackFile geometry/property content.

## Fingerprint

`contentFingerprint` is lowercase SHA-256 of UTF-8 canonical input, without BOM, using only LF and a final LF. The first six lines are:

```text
wfc-model-content-v1
schemaVersion=1
supportProfile=svf-local-7.130.0-v1
format=svf
sdkVersion=7.130.0
entrypoint=resources/output/0/0.svf
```

Each subsequent line is `path<TAB>decimalBytes<TAB>lowercaseSHA256<LF>`, sorted by ordinal ASCII case-sensitive path. The calculation sorts a copy; the published manifest must itself be strictly sorted and unique.

`packageId`, label, source metadata, `preparedAt` and ZIP compression/order/timestamps are excluded. The content fingerprint is distinct from SHA-256 of the complete transport ZIP. Neither is a digital signature or proof of a trusted author.

## Safety limits

| Scope | Default maximum |
|---|---:|
| Outer ZIP | 2 GiB / 2,147,483,648 bytes |
| Total raw resources | 8 GiB / 8,589,934,592 bytes |
| Resource count | 100,000 |
| Individual resource | 2 GiB / 2,147,483,648 bytes |
| Root manifest | 32 MiB / 33,554,432 bytes |
| Nested SVF container, each inflated SVF entry / recognized gzip JSON | 256 MiB / 268,435,456 bytes |
| Aggregate inspected nested structured data, inflated | 1 GiB / 1,073,741,824 bytes |
| Supported nesting | 16 |
| Expansion ratio | 1,200:1 |
| Operation time | 600,000 ms |
| ZIP central-directory metadata | 100 MiB / 104,857,600 bytes |
| Aggregate all-zero local-record alignment padding | 64 KiB / 65,536 bytes |

Opaque terminal binary/property integrity streams are counted separately from structured nested metadata: each remains bounded by the per-file limit, with an 8 GiB computational aggregate cap. The real snapshot has **75,480,079** inspected nested structured bytes and **1,286,939,948** terminal inflated bytes. Treating terminal bytes as structured metadata would incorrectly reject the agreed snapshot. `objects_viewables.json.gz` has approximately 998:1 expansion and remains within the 1,200:1 profile limit.

Archive handling checks central/local headers, CRC and streamed sizes; rejects duplicate entries, links/devices, unsafe/reserved/encoded paths, case collisions, encryption, executable content and external reference declarations. The reader supports the bounded all-zero alignment padding required by the existing SVF. It refuses nonzero hidden bytes and excess metadata/padding. Archive/model data is not loaded into one large Buffer; structured parsing uses its explicit bounded metadata buffers.

## JavaScript API

The public entrypoint is [index.mjs](index.mjs).

```javascript
import { packModel, verifyPackage, PackageError } from './index.mjs';

const abortController = new AbortController();
const report = await verifyPackage('/absolute/path/received.zip', {
  expectedFingerprint: 'b5bb4fbe666b440c73bb1ffd2ee0db01be66146f8002e4a9df8dce8521db1d34',
  extractTo: '/absolute/path/new-extraction',
  signal: abortController.signal,
});
```

`packModel({modelDir, source, output, label, packageId?, preparedAt?, expectedFingerprint?, manifest?, report?, recover?, limits?, signal?})` returns the complete publication/verification report. `verifyPackage(inputZip, {expectedFingerprint?, extractTo?, limits?, signal?})` returns the complete verification report and does not write a report sidecar itself. CLI `--report` handles that output.

Additional exports: `validateManifest`, `parseManifest`, `computeFingerprint`, `canonicalFingerprintInput`, `validateProfile`, `DEFAULT_LIMITS`, `PackageError`. `validateManifest` checks the published manifest contract and returns the same object; raw integrity/reference closure and fingerprint equality are checked by `verifyPackage`. `parseManifest` takes text and always rejects portable duplicate keys. The API can tighten positive safety limits, but cannot widen the v1 defaults. A `PackageError` exposes `code`, `message` and `details`.

## Offline evidence and relocation harness

[tools/offline-guard.mjs](tools/offline-guard.mjs) is optional verification instrumentation, separate from the runtime. It blocks the instrumented Node networking APIs and `.env` reads, and can block explicit original input roots. Settings are supplied through the module's import URL query, not environment variables. Use a new audit target because audit publication is exclusive:

```powershell
$guardUri = ([uri](Join-Path (Get-Location) 'tools/offline-guard.mjs')).AbsoluteUri
$audit = 'D:\Prepared models\offline-audit-new.json'
$guardImport = $guardUri + '?report=' + [uri]::EscapeDataString($audit)
node --import $guardImport cli.mjs verify --package "D:\Prepared models\aalborg-svf-v1.zip"
```

Add repeated URL query parameters `&forbid=` followed by a URL-encoded absolute input directory/file to audit verification without access to it. This is an in-process audit of the selected APIs, not an operating-system sandbox.

[tools/relocated-smoke.mjs](tools/relocated-smoke.mjs) is a temporary localhost-only browser harness. It serves an extracted package plus a separately copied trusted SDK directory and records geometry/property, requests and CSP evidence. Its actual argument syntax is:

```powershell
node tools/relocated-smoke.mjs `
  "--root=D:\Prepared models\received-model" `
  "--sdk-dir=D:\Prepared models\trusted-sdk-7.130.0" `
  "--evidence=D:\Prepared models\browser-smoke.json" `
  --port=0
```

The root must already be a verified extraction, the SDK must already exist locally, and the evidence parent must exist. The harness prints the assigned `http://127.0.0.1:PORT/` URL. Stop it after the browser check (Ctrl+C or `stop` on its open stdin). It does not modify the original Viewer or WFC and is not a production server, iframe bridge or resource-session implementation. The original SDK stylesheet contains ArtifaktElement CDN font URLs: this harness remaps them in the CSS HTTP response to the already copied local Arimo font, records both CSS hashes and the replacement count, and leaves all SDK/model files unchanged. Browser acceptance is recorded separately; a successful package verification does not imply a browser PASS, a second physical-machine result or future WFC integration acceptance.

## Recorded Aalborg result

The generated output is outside the source module, under:

```text
D:\PreparedModels
```

| Item | Recorded value |
|---|---|
| ZIP | `aalborg-svf-v1.zip` |
| ZIP bytes | `439112840` |
| ZIP SHA-256 | `e3056f28efaa57eef65f81dbdfe41396d9e010bdc975738d1259c58af6c3a922` |
| Package UUID | `cc477b02-e0f9-47bc-b965-7064e93404fe` |
| Resource count / raw bytes | `342` / `439007803` |
| Canonical input bytes | `33731` |
| Content fingerprint | `b5bb4fbe666b440c73bb1ffd2ee0db01be66146f8002e4a9df8dce8521db1d34` |
| Source identity | `observed-local-file`, `155285346` bytes |
| Source SHA-256 | `11b2739d92020ee58a52a4e793cf8fd538fb30758eb42176aba93ac7319b048a` |

The sidecars contain the full manifest and machine-readable verification evidence. The recorded fixture run is `evidence/fixture-tests.tap`: **168 passed, 0 failed, 0 skipped**, covering contract, ZIP, profile and package/lifecycle scenarios. Six affected directory checks passed again after the final stored-empty-directory fast path; deflated directories are still fully consumed and checked. Guarded pack and relocated verification audits are separate JSON evidence files. The stage report in the WFC documentation carries the final browser and cleanup results; they are not inferred from these package/test values.
