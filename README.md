# Routings Model Preparer

Standalone Node.js 24 application for preparing, inspecting, verifying and exporting offline SVF model packages. This repository contains the source snapshot from the 20 October 2026 Simplified Preparer bundle.

## Layout

- **preparer-source/**: server, Bulgarian web interface, workflow core, Docker deployment and PowerShell scripts.
- **routings-model-package/**: sibling package creation and verification module. Keep these directories together: the preparer resolves the package module relative to its own directory.

Both modules use Node.js built-ins; no npm dependencies need installing. The package.json private flag prevents accidental npm publication; it does not control GitHub visibility.

## Tests

Use Node.js 24.x. From this repository:

```powershell
Push-Location .\routings-model-package
npm test
Pop-Location
Push-Location .\preparer-source
npm test
Pop-Location
```

## Docker on Windows

Install Docker Desktop with Linux containers, Node.js 24.x and PowerShell. Supply your existing Autodesk configuration file, import/source directories and the original trusted Autodesk Viewer SDK 7.130.0 source bundle, including its vendor-manifest.json. The SDK is an external build input and is not distributed here. prepare-runtime.mjs pins the manifest SHA-256 to 747540a153fb18809c428d8ed177aa8a296cff1b5175ab85445e0a2ebdb36d75 and verifies all 206 declared assets. A generic 7.130.0 download without this inventory cannot satisfy the build. Use the original SDK source bundle; do not point -SdkSource at the generated deployment/preview-runtime directory.

```powershell
git clone https://github.com/MrToKa/routings-model-preparer.git
cd routings-model-preparer\preparer-source
.\start-preparer.ps1 -Build -EnvFilePath 'D:\ModelPreparerConfig\.env' -ImportRoot 'D:\PreparedModels' -SourceDirectory 'D:\SourceModels' -SdkSource 'D:\ViewerSDK\7.130.0'
```

Use existing directories. The configuration requires APS_CLIENT_ID, APS_CLIENT_SECRET, APS_REGION and APS_BUCKET. Keep credentials outside Git. The service defaults to closed mode and http://127.0.0.1:8083/.

For subsequent starts, use the same runtime arguments without -Build. To update from this repository, run git pull --ff-only, then the build command with the same arguments and -Recreate. Preserve your existing runtime settings when updating an installed instance. A plain start reuses the existing image/container and does not deploy new source.

Stop with .\stop-preparer.ps1 from preparer-source. Do not delete Docker volumes to update: they contain persistent application data.

See [deployment documentation](preparer-source/deployment/README.md) and [application documentation](preparer-source/docs/app.md) for detailed configuration and live-mode requirements. In this standalone repository, startup defaults use local .env, imports, sources and vendor/viewer/7.130.0 paths; explicit arguments override them. Older stage documentation describes the original deployment and its historical validation.

## WFC integration and scope

This is a separate application and Compose project (routings-preparer). Updating WFC does not update it. The source includes the optional authenticated WFC workspace. Use -WfcOrigin with the startup script to enable its Compose overlay and automatic verified package imports. WFC main at 96e63f1 already has the required import endpoints; the historical retained-ZIP integration patch is not needed for this upload flow. See [WFC workspace deployment](preparer-source/deployment/WFC-WORKSPACE.md) for SDK reuse from WFC, deployment steps and the remaining desktop validation.

Real models, SDK binaries, account evidence, runtime state, credentials and the original account-specific tools/record-cost-review.mjs utility are excluded. This repository does not grant rights to redistribute Autodesk software or model data. No software license has been selected for this initial import.
