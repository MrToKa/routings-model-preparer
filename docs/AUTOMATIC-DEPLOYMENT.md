# Automatic deployment

`Publish tested deployment` runs the Preparer, workspace and package tests using
the pinned Node 24 image with no network access in the test container. Pull
requests build but do not publish. A `main` update builds the existing production
Dockerfile with its three allowlisted named contexts and publishes
`ghcr.io/mrtoka/routings-model-preparer:<commit>`.

The SDK comes from an exact WFC revision pinned in the workflow. The existing
`prepare-runtime.mjs` verifies the complete SDK 7.130.0 manifest and asset hashes,
then adapts the separate deployment copy. CI does not use live Autodesk keys,
NWD files, production state or external package inputs. The image includes the
SDK: review distribution rights before changing GHCR package visibility.

After all tests and image publication succeed, CI publishes a prerelease tagged
`deploy-<commit>`, containing `deployment.json` with the exact image digest.
Publication happens last. No mutable `latest` tag is used for deployment.

The shared Windows updater lives in
[WFC scripts/cicd](https://github.com/MrToKa/WFC/tree/main/scripts/cicd).
Follow [WFC's host setup and operating guide](https://github.com/MrToKa/WFC/blob/main/docs/AUTOMATIC-DEPLOYMENT.md).
It polls both repositories from inside the LAN and invokes the installed
`start-preparer.ps1` with the configured current live/WFC arguments and the
verified digest. Existing persistent mounts and live/workspace authentication
must match; readiness includes `mode: live` and `authentication: wfc` in the
example. Other modes require explicitly reviewed local configuration.

The one-time setup requires the actual host's Docker access, GHCR login, private
backup/maintenance hooks and a first controlled smoke test. Merging this CI
change alone does not activate automatic restarts. No self-hosted GitHub runner
is installed on the production desktop.

`preparer-v1` is a compatibility contract for stored job/WAL state and the
WFC integration, not an automatic compatibility proof. Review every state or
protocol change before merge. Bump the workflow compatibility string and deploy
manually after a migration/restore rehearsal if the old image cannot read state
written by the new one. Coordinate incompatible WFC changes manually as well.
Image rollback cannot undo a state migration or remote Autodesk submission.

Ordinary in-place deployment briefly interrupts availability. The updater uses
graceful stop without its own SIGKILL deadline; the existing application may
save interrupted operations for explicit continuation. The preparation hook
must arrange an enforced idle/maintenance period and coherent backup of data,
work, outputs and referenced external inputs. This CI change adds no new
admission/drain API. Do not enable unattended updates during active use without
that coordination. Do not automatically recover stale locks, repeat uncertain
submissions, erase volumes, or restore snapshots over newer work.

Local release tests: `node --test scripts/cicd/release.test.mjs`.

## GitHub-triggered deployment and retained versions

After complete publication, `request-lan-deploy` can signal the private
operations repository. Configure `LAN_DEPLOY_REPOSITORY` and secret
`LAN_DEPLOY_TOKEN` as described in the companion WFC deployment guide. A
repository-specific Windows runner in that private repository executes the
reviewed local updater; never register the production runner to this public
repository. No inbound public port is required. Polling remains optional.

The shared updater pins two confirmed working version sets per application:
current and previous. Failed candidates never replace this history. Old managed
rollback tags are released after successful acceptance; infrastructure, volumes,
registry tags and unrelated images are untouched. Image rollback does not
restore state or databases. Event-only busy deployments fail visibly and must
be rerun after the maintenance window is available.
