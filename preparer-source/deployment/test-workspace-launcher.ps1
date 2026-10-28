[CmdletBinding()]
param([string]$Launcher)
$ErrorActionPreference = 'Stop'
if (-not $Launcher) { $Launcher = Join-Path (Split-Path $PSScriptRoot -Parent) 'start-preparer.ps1' }
$taskFixture = Join-Path ([IO.Path]::GetTempPath()) ('workspace-launcher-' + [guid]::NewGuid().ToString())
$null = New-Item -ItemType Directory -Path $taskFixture
$taskConfig = Join-Path $taskFixture 'fixture.env'
[IO.File]::WriteAllText($taskConfig,"APS_CLIENT_ID=fixture-client-id`nAPS_CLIENT_SECRET=fixture-secret-not-real`nAPS_REGION=EMEA`nAPS_BUCKET=fixture-bucket`n")
$global:capturedCompose = $null
$global:capturedWfcOrigin = $null
$global:capturedPolicy = $null
$global:mockAuthentication = 'wfc'
function docker {
    $global:LASTEXITCODE = 0
    $taskArgs = @($args)
    if ($taskArgs[0] -eq 'version') { return '28.0.0' }
    if ($taskArgs[0] -eq 'ps') { return }
    if ($taskArgs[0] -eq 'image') { return 'sha256:fixture' }
    if ($taskArgs[0] -eq 'compose') {
        $global:capturedCompose = $taskArgs
        $global:capturedWfcOrigin = $env:PREPARER_WFC_ORIGIN
        $global:capturedPolicy = $env:PREPARER_LIVE_REUSE_ONLY
        return
    }
    throw ('Unexpected Docker call: ' + ($taskArgs -join ' '))
}
function Get-NetTCPConnection { return }
function Invoke-RestMethod { return [pscustomobject]@{status='ok';mode='live';authentication=$global:mockAuthentication} }
$taskPrevious = $env:PREPARER_WFC_ORIGIN
$env:PREPARER_WFC_ORIGIN = 'https://previous.example.test'
& $Launcher -EnvFilePath $taskConfig -ImportRoot $taskFixture -SourceDirectory $taskFixture -WfcOrigin 'http://host.docker.internal:5180/' -Recreate
if ($global:capturedWfcOrigin -ne 'http://host.docker.internal:5180' -or $global:capturedPolicy -ne 'false') { throw 'Workspace settings did not reach Compose' }
if (-not ($global:capturedCompose | Where-Object { $_ -like '*compose-workspace.yaml' })) { throw 'Workspace overlay is missing' }
if ($env:PREPARER_WFC_ORIGIN -ne 'https://previous.example.test') { throw 'Process environment was not restored' }
foreach ($taskBadOrigin in @('http://user:password@example.test','https://example.test/path','file:///tmp','https://example.test/?x=1')) {
    $taskRejected = $false
    try { & $Launcher -WfcOrigin $taskBadOrigin -EnvFilePath $taskConfig -ImportRoot $taskFixture -SourceDirectory $taskFixture } catch { $taskRejected = $true }
    if (-not $taskRejected) { throw 'Invalid origin accepted' }
}
$taskRejected = $false
try { & $Launcher -WfcOrigin 'http://host.docker.internal:5180' -Mode simulation -EnvFilePath $taskConfig -ImportRoot $taskFixture -SourceDirectory $taskFixture } catch { $taskRejected = $true }
if (-not $taskRejected) { throw 'Conflicting standalone mode accepted' }
$global:mockAuthentication = 'standalone'
$taskRejected = $false
try { & $Launcher -WfcOrigin 'http://host.docker.internal:5180' -EnvFilePath $taskConfig -ImportRoot $taskFixture -SourceDirectory $taskFixture -Recreate } catch { $taskRejected = $_.Exception.Message -like '*does not expose*' }
if (-not $taskRejected) { throw 'Old image was reported as a working workspace' }
$env:PREPARER_WFC_ORIGIN = $taskPrevious
Write-Output 'PASS: workspace overlay, origin validation, configuration forwarding, environment restoration, and old-image rejection'
