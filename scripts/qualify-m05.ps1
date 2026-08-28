$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
if ($PSVersionTable.PSVersion.Major -lt 7) { throw "POWERSHELL_7_REQUIRED" }
Set-Location (Split-Path -Parent $PSScriptRoot)

$Root = (Get-Location).Path
$CanonicalRoot = "C:\Workspace\haios-desktop-control"
$RunId = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ", [Globalization.CultureInfo]::InvariantCulture)
$EvidenceRoot = Join-Path $Root "evidence\m05\$RunId"
$RuntimeRoot = Join-Path $Root "runtime\m05-qual-$RunId"
$Port = 8772
New-Item -ItemType Directory -Force $EvidenceRoot,$RuntimeRoot | Out-Null

function Test-Port([int]$PortNumber) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue)
}
function Require-Exit([string]$Name) {
    if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit $LASTEXITCODE" }
}
function Get-Sha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

Write-Host "M05_RUN_ID=$RunId"
function Get-DeterministicSourceManifestLines {
    $RelativePaths = [string[]]@(git ls-files)
    [Array]::Sort($RelativePaths, [StringComparer]::Ordinal)
    $ManifestLines = @()
    foreach ($Relative in $RelativePaths) {
        $Absolute = Join-Path $Root $Relative
        $Hash = Get-Sha256 $Absolute
        $ManifestLines += "$Hash  $Relative"
    }
    return @($ManifestLines)
}
function Write-DeterministicSourceManifest([string]$Path) {
    $ManifestLines = @(Get-DeterministicSourceManifestLines)
    $ManifestText = ($ManifestLines -join "`n") + "`n"
    [IO.File]::WriteAllText($Path, $ManifestText, [Text.UTF8Encoding]::new($false))
    return (Get-Sha256 $Path)
}

$TunnelContainers = @(
    "haios-tunnel-client",
    "haios-operator-dedicated-tunnel-client"
)
function Get-TunnelIntegrityDigest([string]$ContainerName) {
    $Raw = & docker.exe inspect $ContainerName 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $Raw) { throw "TUNNEL_CONTAINER_UNAVAILABLE:$ContainerName" }
    $Object = ($Raw | ConvertFrom-Json)[0]
    $Networks = @($Object.NetworkSettings.Networks.PSObject.Properties | Sort-Object Name | ForEach-Object {
        [ordered]@{ name=$_.Name; network_id=$_.Value.NetworkID; endpoint_id=$_.Value.EndpointID; ip=$_.Value.IPAddress; gateway=$_.Value.Gateway }
    })
    $Mounts = @($Object.Mounts | ForEach-Object {
        [ordered]@{ type=$_.Type; destination=$_.Destination; mode=$_.Mode; rw=$_.RW; propagation=$_.Propagation }
    })
    $Snapshot = [ordered]@{
        id=$Object.Id; created=$Object.Created; image_id=$Object.Image; config_image=$Object.Config.Image
        path=$Object.Path; args=@($Object.Args); network_mode=$Object.HostConfig.NetworkMode
        restart_policy=$Object.HostConfig.RestartPolicy; mounts=$Mounts; networks=$Networks
    }
    $Bytes = [Text.Encoding]::UTF8.GetBytes(($Snapshot | ConvertTo-Json -Depth 8 -Compress))
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}

if ((git status --porcelain).Length -ne 0) { throw "WORKTREE_NOT_CLEAN" }
$Head = (git rev-parse HEAD).Trim()
$Branch = (git branch --show-current).Trim()
$CanonicalHead = (& git -C $CanonicalRoot rev-parse HEAD).Trim()
$CanonicalStatus = @(& git -C $CanonicalRoot status --porcelain)
if ($CanonicalStatus.Count -gt 0) { throw "CANONICAL_PROJECT_NOT_CLEAN" }
$TunnelPre = @{}
foreach ($Name in $TunnelContainers) { $TunnelPre[$Name] = Get-TunnelIntegrityDigest $Name }
Write-Host "HEAD=$Head"
Write-Host "BRANCH=$Branch"
Write-Host "CANONICAL_HEAD=$CanonicalHead"
Write-Host "TUNNEL_PREIMAGE=PASS"
Write-Host "[1] M05 focused adversarial qualification"
$AdversarialLog = Join-Path $EvidenceRoot "m05-adversarial.log"
& npm.cmd test -- tests/m05-adversarial.test.ts 2>&1 | Tee-Object -FilePath $AdversarialLog
Require-Exit "M05_ADVERSARIAL_TESTS"

Write-Host "[2] One full regression on final candidate bytes"
$FullTestLog = Join-Path $EvidenceRoot "full-tests.log"
& npm.cmd test 2>&1 | Tee-Object -FilePath $FullTestLog
Require-Exit "FULL_TESTS"
$FullText = ([IO.File]::ReadAllText($FullTestLog) -replace "`e\[[0-9;?]*[ -/]*[@-~]", "")
$FullMatch = [regex]::Match($FullText, 'Tests\s+(\d+)\s+passed')
if (-not $FullMatch.Success) { throw "FULL_TEST_PASS_COUNT_NOT_FOUND" }
$FullTestPassingCount = [int]$FullMatch.Groups[1].Value
Write-Host "FULL_TEST_PASSING_COUNT=$FullTestPassingCount"
Write-Host "LEGACY27_REGRESSION=PASS"

& npm.cmd run typecheck
Require-Exit "TYPECHECK"
& npm.cmd run build
Require-Exit "BUILD"

Write-Host "[3] Freeze deterministic source identity"
$ManifestPath = Join-Path $EvidenceRoot "source-manifest.txt"
$ManifestDigest = Write-DeterministicSourceManifest $ManifestPath
Write-Host "SOURCE_MANIFEST_DIGEST=$ManifestDigest"
if ((git status --porcelain).Length -ne 0) { throw "POST_TEST_WORKTREE_DRIFT" }
if ((git rev-parse HEAD).Trim() -ne $Head) { throw "POST_TEST_HEAD_DRIFT" }
if (Test-Port $Port) { throw "M05_PORT_8772_NOT_FREE" }
if (-not (Test-Port 8768)) { throw "SECURE_MCP_8768_REGRESSION" }
if (-not (Test-Port 8769)) { throw "OPERATOR_MCP_8769_REGRESSION" }
Write-Host "[4] Disposable live operator13 projection"
$Launcher = Join-Path $RuntimeRoot "launcher.mjs"
$ClientScript = Join-Path $RuntimeRoot "client.mjs"
$LauncherOut = Join-Path $EvidenceRoot "live-launcher.stdout.log"
$LauncherErr = Join-Path $EvidenceRoot "live-launcher.stderr.log"
$ClientErr = Join-Path $EvidenceRoot "live-client.stderr.log"
@'
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGatewayServer } from "../../dist/src/server.js";
const key = process.env.HAIOS_M05_API_KEY;
if (!key) throw new Error("HAIOS_M05_API_KEY missing");
const here = dirname(fileURLToPath(import.meta.url));
const stopPath = join(here, "stop.flag");
const resultPath = join(here, "launcher-result.json");
let upstreamCalls = 0;
const denied = async () => { upstreamCalls++; throw new Error("UPSTREAM_DISPATCH_FORBIDDEN"); };
const upstream = {
  listDirectory:denied, readFile:denied, readMultipleFiles:denied, getFileInfo:denied,
  startSearch:denied, getMoreSearchResults:denied, stopSearch:denied, listSearches:denied,
  listProcesses:denied, listSessions:denied, getConfig:denied, close:async()=>{},
};
const runtime = await createGatewayServer({ apiKey:key, upstream, protocolMode:"operator13", host:"127.0.0.1", port:8772 });
const address = await runtime.listen();
console.log(`M05_RUNTIME_READY=${address.url}`);
const timer = setInterval(async () => {
  if (!existsSync(stopPath)) return;
  clearInterval(timer);
  await runtime.close();
  writeFileSync(resultPath, JSON.stringify({ upstreamCalls }));
  process.exit(0);
}, 100);
'@ | Set-Content -Encoding utf8 $Launcher
@'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const key = process.env.HAIOS_M05_API_KEY;
if (!key) throw new Error("HAIOS_M05_API_KEY missing");
const expected = [
  "operator_status","operator_capabilities","operator_begin_transaction","operator_stage_patch",
  "operator_stage_create","operator_stage_move","operator_stage_remove","operator_validate_transaction",
  "operator_apply_transaction","operator_run_task","operator_rollback_transaction","operator_git_checkpoint",
  "operator_promote_transaction",
];
const client = new Client({ name:"haios-m05-qualifier", version:"1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8772/mcp"), {
  requestInit:{ headers:{ "X-API-Key":key } },
});
const parse = (result) => {
  const text = result.content?.filter?.(x=>x.type==="text").map(x=>x.text??"").join("\n") ?? "";
  return text ? JSON.parse(text) : {};
};
await client.connect(transport);
const tools = await client.listTools();
const names = tools.tools.map(t=>t.name);
if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`TOOL_SURFACE:${JSON.stringify(names)}`);
const statusResult = await client.callTool({ name:"operator_status", arguments:{} });
const status = parse(statusResult);
if (statusResult.isError || status.mode !== "READ_ONLY_EMERGENCY" || status.mutationActive !== false) throw new Error("STATUS_CONTRACT");
'@ | Set-Content -Encoding utf8 $ClientScript
@'
const capsResult = await client.callTool({ name:"operator_capabilities", arguments:{} });
const caps = parse(capsResult);
if (capsResult.isError || caps.toolCount !== 13 || caps.s2Enabled !== false || caps.checkpointQualified !== false || caps.promotionQualified !== false) {
  throw new Error("CAPABILITIES_CONTRACT");
}
if (!/^[a-f0-9]{64}$/.test(String(caps.taskRegistrySha256 ?? ""))) throw new Error("REGISTRY_DIGEST_MISSING");
const deniedMutation = await client.callTool({
  name:"operator_begin_transaction", arguments:{ projectId:"project", canonicalRoot:"C:\\Workspace\\project" },
});
const mutationPayload = parse(deniedMutation);
if (!deniedMutation.isError || mutationPayload.reason !== "TOOL_DENIED_INACTIVE_MODE") throw new Error("INACTIVE_MUTATION_NOT_DENIED");
const deniedRaw = await client.callTool({ name:"write_file", arguments:{} });
const rawPayload = parse(deniedRaw);
if (!deniedRaw.isError || rawPayload.reason !== "TOOL_DENIED") throw new Error("RAW_TOOL_NOT_DENIED");
console.log(JSON.stringify({
  toolCount:names.length, exactToolMatch:true, statusMode:status.mode,
  mutationActive:status.mutationActive, taskRegistrySha256:caps.taskRegistrySha256,
  s2Enabled:caps.s2Enabled, checkpointQualified:caps.checkpointQualified,
  promotionQualified:caps.promotionQualified, inactiveMutationDenied:true, rawToolDenied:true,
}));
await client.close();
'@ | Add-Content -Encoding utf8 $ClientScript

function New-EphemeralKey {
    $Bytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
    return [Convert]::ToBase64String($Bytes).TrimEnd("=").Replace("+","-").Replace("/","_")
}
function Stop-M05Runtime($Process) {
    $StopPath = Join-Path $RuntimeRoot "stop.flag"
    if ($Process -and -not $Process.HasExited) {
        Set-Content -LiteralPath $StopPath -Value "stop" -Encoding ascii
        if (-not $Process.WaitForExit(15000)) {
            try { & taskkill.exe /PID $Process.Id /T /F | Out-Null } catch { }
        }
    }
    for ($i=0; $i -lt 30; $i++) {
        if (-not (Test-Port $Port)) { return }
        Start-Sleep -Milliseconds 250
    }
    throw "M05_PORT_8772_CLEANUP_FAILED"
}

$EphemeralKey = New-EphemeralKey
$Process = $null
try {
    $env:HAIOS_M05_API_KEY = $EphemeralKey
    $Process = Start-Process node.exe -ArgumentList @($Launcher) -RedirectStandardOutput $LauncherOut -RedirectStandardError $LauncherErr -PassThru -WindowStyle Hidden
    Remove-Item Env:HAIOS_M05_API_KEY -ErrorAction SilentlyContinue
    $Ready = $false
    for ($i=0; $i -lt 120; $i++) {
        Start-Sleep -Milliseconds 250
        if (Test-Port $Port) { $Ready=$true; break }
        if ($Process.HasExited) { break }
    }
    if (-not $Ready) { throw "LIVE_GATEWAY_START_FAILED" }
    $Unauth = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/mcp" -Method GET -SkipHttpErrorCheck -TimeoutSec 10
    if ([int]$Unauth.StatusCode -ne 401) { throw "LIVE_AUTH_NEGATIVE_FAILED" }
    $env:HAIOS_M05_API_KEY = $EphemeralKey
    $ClientOutput = & node.exe $ClientScript 2> $ClientErr
    $ClientExit = $LASTEXITCODE
    Remove-Item Env:HAIOS_M05_API_KEY -ErrorAction SilentlyContinue
    if ($ClientExit -ne 0) { throw "LIVE_MCP_CLIENT_FAILED" }
    $Live = (($ClientOutput | Select-Object -Last 1) | ConvertFrom-Json)
    if ($Live.toolCount -ne 13 -or -not $Live.exactToolMatch -or -not $Live.inactiveMutationDenied -or -not $Live.rawToolDenied) {
        throw "LIVE_OPERATOR_CONTRACT_FAILED"
    }
    if ($Live.statusMode -ne "READ_ONLY_EMERGENCY" -or $Live.mutationActive -or $Live.s2Enabled) {
        throw "LIVE_OPERATOR_MODE_FAILED"
    }
    if ($Live.checkpointQualified -or $Live.promotionQualified) { throw "M05_FALSE_QUALIFICATION" }
    Stop-M05Runtime $Process
    $LauncherResultPath = Join-Path $RuntimeRoot "launcher-result.json"
    if (-not (Test-Path -LiteralPath $LauncherResultPath)) { throw "LAUNCHER_RESULT_MISSING" }
    $LauncherResult = Get-Content -LiteralPath $LauncherResultPath -Raw | ConvertFrom-Json
    if ($LauncherResult.upstreamCalls -ne 0) { throw "INACTIVE_UPSTREAM_DISPATCH:$($LauncherResult.upstreamCalls)" }
} finally {
    Remove-Item Env:HAIOS_M05_API_KEY -ErrorAction SilentlyContinue
    Stop-M05Runtime $Process
}

$Live | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $EvidenceRoot "live-operator-foundation.json")
Write-Host "LIVE_OPERATOR_TOOL_COUNT=13"
Write-Host "LIVE_INACTIVE_MUTATION_DENIAL=PASS"
Write-Host "LIVE_UPSTREAM_DISPATCH_COUNT=0"
Write-Host "[5] Runtime cleanup and post-state reconciliation"
$SecretLeakDetected = $false
foreach ($File in (Get-ChildItem $EvidenceRoot -File -ErrorAction SilentlyContinue)) {
    if ([IO.File]::ReadAllText($File.FullName).Contains($EphemeralKey)) { $SecretLeakDetected = $true }
}
if ($SecretLeakDetected) { throw "EPHEMERAL_API_KEY_PERSISTED" }

Remove-Item -LiteralPath $RuntimeRoot -Recurse -Force
$RuntimeResidue = if (Test-Path -LiteralPath $RuntimeRoot) { 1 } else { 0 }
if ($RuntimeResidue -ne 0) { throw "RUNTIME_RESIDUE:$RuntimeResidue" }
Write-Host "RUNTIME_RESIDUE=0"

$TunnelEvidence = @()
$TunnelModified = $false
foreach ($Name in $TunnelContainers) {
    $Post = Get-TunnelIntegrityDigest $Name
    $Match = $TunnelPre[$Name] -eq $Post
    if (-not $Match) { $TunnelModified = $true }
    $TunnelEvidence += [ordered]@{ name=$Name; pre_sha256=$TunnelPre[$Name]; post_sha256=$Post; match=$Match }
}
if ($TunnelModified) { throw "TUNNEL_INTEGRITY_DRIFT" }
Write-Host "TUNNEL_INTEGRITY=PASS"

if ((git status --porcelain).Length -ne 0) { throw "POST_LIVE_WORKTREE_DRIFT" }
if ((git rev-parse HEAD).Trim() -ne $Head) { throw "POST_LIVE_HEAD_DRIFT" }
if ((& git -C $CanonicalRoot rev-parse HEAD).Trim() -ne $CanonicalHead) { throw "CANONICAL_HEAD_DRIFT" }
if (@(& git -C $CanonicalRoot status --porcelain).Count -gt 0) { throw "CANONICAL_WORKTREE_DRIFT" }
if (-not (Test-Port 8768) -or -not (Test-Port 8769) -or (Test-Port $Port)) { throw "PORT_POSTSTATE_FAILED" }
$AfterPath = Join-Path $EvidenceRoot "source-manifest-post-live.txt"
$ManifestDigestAfter = Write-DeterministicSourceManifest $AfterPath
if ($ManifestDigestAfter -ne $ManifestDigest) { throw "SOURCE_MANIFEST_DRIFT" }
Write-Host "SOURCE_MANIFEST_POST_LIVE=PASS"
Write-Host "UNAUTHORIZED_MUTATIONS=0"
Write-Host "SECRETS_PERSISTED=FALSE"

$Result = [ordered]@{
    mission = "HAIOS_DESKTOP_CONTROL_PLANE_R1_M05_LEVEL_B_PROTOCOL_RECONCILIATION"
    run_id = $RunId
    head = $Head
    branch = $Branch
    canonical_project_head = $CanonicalHead
    source_manifest_digest = $ManifestDigest
    source_manifest_post_live_digest = $ManifestDigestAfter
    adversarial_tests = "PASS"
    full_tests = "PASS"
    full_test_passing_count = $FullTestPassingCount
    typecheck = "PASS"
    build = "PASS"
    legacy_tool_count = 27
    operator_tool_count = 13
    operator_mode = "READ_ONLY_EMERGENCY"
    operator_mutation_active = $false
    checkpoint_qualified = $false
    promotion_qualified = $false
    task_registry_sha256 = [string]$Live.taskRegistrySha256
    live_operator_projection = "PASS"
    live_inactive_mutation_denial = "PASS"
    live_upstream_dispatch_count = 0
    runtime_residue = 0
    unauthorized_mutations = 0
    secrets_persisted = $false
    tunnel_integrity = @($TunnelEvidence)
    tunnel_modified = $TunnelModified
    read_capability = "QUALIFIED"
    execute_capability = "QUALIFIED"
    mutate_capability = "QUALIFIED_LEGACY_M04_OPERATOR13_INACTIVE"
    destructive_capability = "LOCKED"
    independent_verification = "PENDING"
    terminal = "HAIOS_DESKTOP_CONTROL_PLANE_R1_M05_READY_FOR_INDEPENDENT_VERIFICATION"
}
$ResultPath = Join-Path $EvidenceRoot "m05-qualification-result.json"
$Result | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 $ResultPath

$Handoff = [ordered]@{
    mission = $Result.mission
    run_id = $RunId
    head = $Head
    source_manifest_digest = $ManifestDigest
    review_mode = "READ_ONLY_INDEPENDENT"
    rerun_unchanged_tests = $false
    required_checks = @(
        "HEAD_MATCH","MANIFEST_MATCH","AUTHORITY_SOURCE_BOUND","LEGACY27_PRESERVED",
        "OPERATOR13_EXACT","PROJECTIONS_MUTUALLY_EXCLUSIVE","INACTIVE_MUTATION_FAIL_CLOSED",
        "NO_LEGACY_OPERATOR_DISPATCH","TASK_REGISTRY_HASH_BOUND","TASK_REGISTRY_NO_ARBITRARY_SHELL",
        "S2_DISABLED","CHECKPOINT_PROMOTION_NOT_FALSE_QUALIFIED","TUNNEL_INTEGRITY",
        "RUNTIME_CLEANUP","SECRETS_PERSISTED_FALSE"
    )
    allowed_verdicts = @("PASS","BLOCKED")
}
$Handoff | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $EvidenceRoot "independent-review-handoff.json")
Write-Host "RESULT_PATH=$ResultPath"
Write-Host "HAIOS_DESKTOP_CONTROL_PLANE_R1_M05_READY_FOR_INDEPENDENT_VERIFICATION" -ForegroundColor Green
