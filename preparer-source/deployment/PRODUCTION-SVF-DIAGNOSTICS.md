# Production SVF discovery and download diagnosis

The laptop test environment and desktop WFC workspace are separate deployments.
A previous successful package does not prove that a current cloud derivative,
provider configuration or production image is identical.

## Existing SVF discovery

The WFC workspace creates the APS provider with `reuseOnly: false` so that new
models can be uploaded and translated when authorized. This must not disable
read-only discovery of existing Viewer SVF representations in a successful
legacy manifest. That discovery is controlled independently by
`allowLegacyExistingSVF` (default `true`).

The provider checks the current manifest first. Only a successful manifest with
no compatible SVF candidate can cause a read of the regional legacy manifest.
Pending and failed derivatives keep their existing states. The fallback never
submits a conversion, forces a translation or relaxes object/root identity checks.
Setting `allowLegacyExistingSVF: false` disables it in both provider modes.

## Separate production failures

A failure at `prepare` with submission phase `none` can come from derivative
discovery before any new translation is submitted. A failure at
`download-aps-root-*` with submission phase `complete` is a later operation. Its
`DOWNLOAD_INVALID` code alone cannot distinguish malformed SVF metadata, a byte
size mismatch, duplicate resources or a normalized plan contract failure.

The following JSON events now retain the specific failing check:

- `aps-manifest-rejected`: no supported SVF root after configured discovery.
- `aps-download-rejected`: SVF envelope inspection, declared/signed byte counts,
  HTTP Content-Length, or duplicate resources.
- `download-plan-rejected`: normalized plan fields, header, resource identities,
  byte/hash metadata, or duplicate paths/identities.

Events include an opaque submission identity, fixed technical labels and, where
applicable, resource indices and byte counts. Package cause codes and selected
validator checks are allowlisted. Foreign messages/details, resource names,
provider URLs, cookies, tokens and response bodies are not logged.

After rebuilding the Preparer, resume one existing failed operation and inspect:

```powershell
docker logs --since 10m --tail 300 routings-preparer-preparer-1 2>&1 |
    Select-String 'aps-manifest-rejected|aps-download-rejected|download-plan-rejected|svf-profile-rejected'
```

These changes require a Preparer rebuild. They do not change the package format,
WFC verifier, existing volumes or downloaded checkpoints. A diagnostic event is
evidence of a specific rejected check; it is not permission to bypass that check.

## Validation

Targeted provider and plan-validation tests cover production legacy discovery,
the explicit off switch, pending/failed manifests, identity boundaries, no new
conversion during fallback, size mismatches, duplicate resources and diagnostic
privacy. They use controlled transport fixtures, not the desktop production APS
account. Production completion of a failed model must be checked separately.

## Inspect a rejected path without rebuilding or restarting

For `causeCheck: asset-basename`, the broad error does not show whether the URI
contains a directory, a parent segment, an encoded character or another unsupported
form. Fetch the diagnostic script with `git pull --ff-only`, then pipe it to the
existing container from the repository's `preparer-source` directory:

```powershell
Get-Content -LiteralPath .\tools\diagnose-svf-paths.mjs -Raw |
    docker exec -i --workdir /opt/preparer routings-preparer-preparer-1 `
        node --input-type=module - SUBMISSION_IDENTITY_FROM_THE_LOG
```

Replace the final argument with the exact 64-character submission identity from
the failed download event. The command selects only a failed download matching
that identity. It reads committed state in read-only mode and existing encrypted
settings, requests a token with read-only scopes, and obtains only the selected
SVF envelope. It stops before signing or fetching any sibling resources. It never
starts a job, acquires a service lease, writes checkpoints, changes settings or
restarts a container. The command has an eight-request cap and a 30-second network
deadline; the selected envelope is capped at 1 MiB.

The output preserves separators, dot/parent segments, generic folder names,
file suffixes and character-class flags. Private filenames, source paths, URLs,
credentials and token values are omitted. The script can be piped to the current
image; a new image build is not required to run this diagnostic.


## Resume large downloads without rebuilding every signed address

The download plan uses the byte counts from the inspected SVF declarations.
Declared siblings are signed only when the adapter actually requests their bytes,
after checking an existing local file against the durable size and SHA-256
checkpoint. The root SVF is still fetched and inspected on each attempt. The
mandatory property DB still needs one signing/metadata request to discover its
size, because that size is outside the SVF declarations.

Before any sibling body request, the signed size must equal the immutable plan.
The same check applies after expiry or the single permitted 403 refresh. The
plan digest, checkpoint format, total/file limits, read budget and 30-minute
transport deadline are unchanged. A missing or corrupt local file is fetched
again; verified completed files do not need another signed address or body.

The log reports `download-plan-ready` and `download-transfer-complete` with
planned/completed/reused/downloaded counts. A `download-limit-exceeded` event
reports `transport-deadline` or `resource-limit`, the current phase, resource
index and elapsed milliseconds. Paths and resource names stay private.

## Inspect the two material documents without another image build

A `ProteinMaterials` asset type can declare both `Materials.json.gz` and
`ProteinMaterials.json.gz`. Viewer 7.130.0 loads them into separate material
structures. A filename allowlist change alone does not establish support for
the second structure or its texture references.

For an existing failed download containing both declarations:

```powershell
Get-Content -LiteralPath .\tools\diagnose-svf-materials.mjs -Raw |
    docker exec -i --workdir /opt/preparer routings-preparer-preparer-1 `
        node --input-type=module - SUBMISSION_IDENTITY_FROM_THE_LOG
```

This isolated read-only diagnostic fetches the selected root and those two
material bodies, with read-only OAuth scopes, at most 16 HTTP requests and a
30-second network deadline. It may read mandatory DB metadata while constructing
the plan; it does not fetch the DB body, geometry or image bodies. The root and
each compressed material file are capped at 1 MiB, with at most 16 MiB of inflated
JSON per material document. No journal, checkpoint, setting or model file is
written.

Only technical structure and counts are returned: file basenames, actual byte
counts, encoding, root/group/node field names, material definitions, texture
shapes and counts of declared/undeclared image strings. Material IDs, tags,
property values, image filenames, URLs, cookies and credentials are omitted.


## Inspect a rejected duplicate JSON key without restarting

A `duplicate-json-key` rejection does not identify which embedded document or
key was rejected. Run the isolated helper against the failed submission:

```powershell
Get-Content .\tools\diagnose-svf-duplicates.mjs -Raw | docker exec -i --workdir /opt/preparer routings-preparer-preparer-1 node --input-type=module - SUBMISSION_IDENTITY
```

It reads only the root SVF, with the same read-only state access, OAuth scopes,
eight-request cap, 30-second deadline and 1 MiB envelope cap as the path helper.
It inspects manifest.json and metadata.json and returns duplicate count, embedded
entry, allowlisted technical key, key fingerprint, value types, structural
equality and allowlisted unit codes. Unknown keys and all other values remain
private. At most 64 duplicates are reported. It does not change the strict
runtime parser, approve a package, fetch sibling resources or write state.
