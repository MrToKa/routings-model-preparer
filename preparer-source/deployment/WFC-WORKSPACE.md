# WFC workspace deployment

The launcher accepts -WfcOrigin to enable the existing authenticated workspace. After a verified model package is prepared, it uploads the ZIP to the selected WFC project through POST /api/projects/:projectId/model-imports and waits for import completion. The package SHA-256, exact length and persistent idempotency key accompany the stream. A failed import keeps the verified ZIP for a retry without converting the source again.

The model is imported as a project version; it is not automatically selected as the active model. Selecting an active model remains a separate WFC operation.

## Prerequisites

- Windows PowerShell, Node.js 24, Docker Desktop Linux containers.
- Current source checkout of this repo and WFC.
- Existing APS .env, source and import directories, and preserved Docker data volumes.
- Original trusted SDK input. WFC commit 96e63f13fdc2b1d30b8f8ff658dd662f25fac104 includes all 206 SDK files plus vendor-manifest.json under viewer-runtime/sdk/7.130.0. Its manifest SHA-256 is 747540a153fb18809c428d8ed177aa8a296cff1b5175ab85445e0a2ebdb36d75, matching prepare-runtime.mjs. The build still verifies every asset's size and hash.
- A WFC HTTP(S) origin reachable from inside the preparer container. On Docker Desktop, host.docker.internal addresses the Windows host. Determine the actual published WFC web/API port with docker port wfc-web or docker port wfc-api. localhost inside the preparer container is not the WFC host.

WFC main at 96e63f1 already implements the required authenticated login, current user, project authorization and model-import endpoints. The historical patch for retained ZIP downloads is not required for this upload flow. Do not apply that patch just to enable automatic imports.

## Update and start

From preparer-source, after checking SDK location and WFC port:

```powershell
git pull --ff-only
$wfcOrigin = Read-Host 'WFC origin reachable from Docker (for example http://host.docker.internal:5180)'
$sdkSource = Read-Host 'Full path to the original viewer-runtime\sdk\7.130.0 folder'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-preparer.ps1 `
  -Build -Recreate -Mode live `
  -ListenAddress '192.168.5.55' -Port 8083 `
  -EnvFilePath 'D:\WFC-Preparer\Config\.env' `
  -ImportRoot 'D:\WFC-Preparer\Packages' `
  -SourceDirectory 'D:\WFC-Preparer\Sources' `
  -SdkSource $sdkSource -WfcOrigin $wfcOrigin
```

The address and paths above describe the known desktop installation. Keep its volumes. The launcher adds compose-workspace.yaml, binds the fixed WFC origin into the runtime configuration identity, restores process environment variables afterwards and rejects a successful health response from an old standalone image. Do not combine -WfcOrigin with simulation mode or legacy price-proof/AllowNewCloudPreparation switches.

Building takes place before container replacement. Until build succeeds, the existing container remains in use. After an earlier unclean stop with LOCK_BUSY, use the documented controlled stopped-container recovery; do not delete locks or volumes manually.

## Use and verify

1. Open http://192.168.5.55:8083/ and sign in using a WFC Engineer or Administrator account.
2. An administrator verifies Autodesk settings. The existing APS configuration seeds credentials; the workspace still requires explicit Free-plan confirmation and an Autodesk access check. An account declaration/access check does not independently verify remaining quota or guarantee zero charges.
3. Select an editable WFC project and source, then choose Generate. This is an explicit cloud-operation request; deployment/startup alone performs no conversion or upload.
4. The flow prepares, verifies and automatically imports the ZIP into that project. A multi-view model can require a view choice. If WFC import fails, retain the ZIP and resume the same generation.
5. Confirm the completed generation and new model version in WFC. Choose it as active separately if desired.

GET /health should return status ok, mode live and authentication wfc. Healthy means the process is running; it does not establish WFC connectivity, a valid login, Autodesk access or successful model import.

## Validation in this change

The mocked PowerShell launcher test covers origin normalization/rejection, workspace overlay selection, runtime forwarding, process environment restoration, conflicting modes and old-image health rejection. It performs no Docker operations. Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deployment\test-workspace-launcher.ps1
```

Three workspace configuration tests passed on Node.js 24. The HTTP workspace integration suite could not pass in the sandbox: loopback requests returned EACCES. No desktop Docker build, real WFC login/import or Autodesk conversion was executed by this change. Complete those checks on the target desktop.
