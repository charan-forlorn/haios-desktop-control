$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
if ($PSVersionTable.PSVersion.Major -lt 7) { throw "POWERSHELL_7_REQUIRED" }
Set-Location (Split-Path -Parent $PSScriptRoot)

$Root = (Get-Location).Path
$ProjectRoot = "C:\Workspace\haios-desktop-control"
$RunId = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ", [Globalization.CultureInfo]::InvariantCulture)
$EvidenceRoot = Join-Path $Root "evidence\m04\$RunId"
$RuntimeRoot = Join-Path $Root "runtime\m04-qual-$RunId"
$FixtureRoot = Join-Path $ProjectRoot "runtime\m04-live-$RunId"
$Port = 8772
New-Item -ItemType Directory -Force $EvidenceRoot,$RuntimeRoot,$FixtureRoot | Out-Null

function Test-Port([int]$PortNumber) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue)
}

function Require-Exit([string]$Name) {
    if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit $LASTEXITCODE" }
}

function Get-DeterministicSourceManifestLines {
    $RelativePaths = [string[]]@(git ls-files)
    [Array]::Sort($RelativePaths, [StringComparer]::Ordinal)
    $ManifestLines = @()
    foreach ($Relative in $RelativePaths) {
        $Absolute = Join-Path $Root $Relative
        $Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Absolute).Hash.ToLowerInvariant()
        $ManifestLines += "$Hash  $Relative"
    }
    return @($ManifestLines)
}

function Write-DeterministicSourceManifest([string]$Path) {
    $ManifestLines = @(Get-DeterministicSourceManifestLines)
    $ManifestText = ($ManifestLines -join "`n") + "`n"
    [IO.File]::WriteAllText($Path, $ManifestText, [Text.UTF8Encoding]::new($false))
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
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
        [ordered]@{ name=$_.Name; network_id=$_.Value.NetworkID; endpoint_id=$_.Value.EndpointID; ip=$_.Value.IPAddress; gateway=$_.Value.Gateway; aliases=@($_.Value.Aliases) }
    })
    $Mounts = @($Object.Mounts | ForEach-Object {
        [ordered]@{ type=$_.Type; source=$_.Source; destination=$_.Destination; mode=$_.Mode; rw=$_.RW; propagation=$_.Propagation }
    })
    $Snapshot = [ordered]@{
        id=$Object.Id; created=$Object.Created; image_id=$Object.Image; config_image=$Object.Config.Image
        path=$Object.Path; args=@($Object.Args); network_mode=$Object.HostConfig.NetworkMode
        restart_policy=$Object.HostConfig.RestartPolicy; mounts=$Mounts; networks=$Networks
    }
    $Bytes = [Text.Encoding]::UTF8.GetBytes(($Snapshot | ConvertTo-Json -Depth 8 -Compress))
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}

Write-Host "M04_RUN_ID=$RunId"
if ((git status --porcelain).Length -ne 0) { throw "WORKTREE_NOT_CLEAN" }
$Head = (git rev-parse HEAD).Trim()
$Branch = (git branch --show-current).Trim()
$CanonicalHead = (& git -C $ProjectRoot rev-parse HEAD).Trim()
if ((& git -C $ProjectRoot status --porcelain).Length -ne 0) { throw "CANONICAL_PROJECT_NOT_CLEAN" }
$TunnelPreDigests = @{}
foreach ($TunnelContainer in $TunnelContainers) {
    $TunnelPreDigests[$TunnelContainer] = Get-TunnelIntegrityDigest $TunnelContainer
}
Write-Host "HEAD=$Head"
Write-Host "BRANCH=$Branch"
Write-Host "CANONICAL_PROJECT_HEAD=$CanonicalHead"
Write-Host "TUNNEL_PREIMAGE=PASS"

Write-Host "[1] Focused adversarial qualification"
$AdversarialLog = Join-Path $EvidenceRoot "m04-adversarial.log"
& npm.cmd test -- tests/m04-adversarial.test.ts 2>&1 | Tee-Object -FilePath $AdversarialLog
Require-Exit "M04_ADVERSARIAL_TESTS"

Write-Host "[2] One full regression on final candidate bytes"
$FullTestLog = Join-Path $EvidenceRoot "full-tests.log"
& npm.cmd test 2>&1 | Tee-Object -FilePath $FullTestLog
Require-Exit "FULL_TESTS"
$FullTestText = ([IO.File]::ReadAllText($FullTestLog) -replace "`e\[[0-9;?]*[ -/]*[@-~]", "")
$FullTestMatch = [regex]::Match($FullTestText, 'Tests\s+(\d+)\s+passed')
if (-not $FullTestMatch.Success) { throw "FULL_TEST_PASS_COUNT_NOT_FOUND" }
$FullTestPassingCount = [int]$FullTestMatch.Groups[1].Value
Write-Host "FULL_TEST_PASSING_COUNT=$FullTestPassingCount"

& npm.cmd run typecheck
Require-Exit "TYPECHECK"
& npm.cmd run build
Require-Exit "BUILD"
Write-Host "[3] Frozen source identity and live preconditions"
$ManifestPath = Join-Path $EvidenceRoot "source-manifest.txt"
$ManifestDigest = Write-DeterministicSourceManifest $ManifestPath
Write-Host "SOURCE_MANIFEST_DIGEST=$ManifestDigest"

if ((git status --porcelain).Length -ne 0) { throw "POST_TEST_WORKTREE_DRIFT" }
if ((git rev-parse HEAD).Trim() -ne $Head) { throw "POST_TEST_HEAD_DRIFT" }
if (Test-Port 8771) { throw "Q2R1_PORT_8771_NOT_FREE" }
if (Test-Port $Port) { throw "M04_PORT_8772_NOT_FREE" }
if (-not (Test-Port 8768)) { throw "SECURE_MCP_8768_REGRESSION" }
if (-not (Test-Port 8769)) { throw "OPERATOR_MCP_8769_REGRESSION" }

$Launcher = Join-Path $RuntimeRoot "launcher.mjs"
$ClientScript = Join-Path $RuntimeRoot "client.mjs"
$PositiveOut = Join-Path $EvidenceRoot "live-positive.stdout.log"
$PositiveErr = Join-Path $EvidenceRoot "live-positive.stderr.log"
$FailureOut = Join-Path $EvidenceRoot "live-failure.stdout.log"
$FailureErr = Join-Path $EvidenceRoot "live-failure.stderr.log"
@'
import { join } from "node:path";
import { TransactionMutationAdapter } from "../../dist/src/transactions/adapter.js";
import { createGitCurrentnessProvider, TRANSACTION_PROJECT_ROOT } from "../../dist/src/transactions/currentness.js";
import { TransactionService } from "../../dist/src/transactions/service.js";
import { dispatchExecuteTool } from "../../dist/src/execute.js";
import { createGatewayServer } from "../../dist/src/server.js";
import { DesktopCommanderClient } from "../../dist/src/upstream.js";
const key = process.env.HAIOS_M04_API_KEY;
const mode = process.env.HAIOS_M04_VERIFY_MODE ?? "pass";
if (!key) throw new Error("HAIOS_M04_API_KEY missing");
const upstream = await DesktopCommanderClient.connect();
const verifier = mode === "failure" ? async () => false : async () => {
  const result = await dispatchExecuteTool("project_test", {}, { upstream });
  return result.decision === "ALLOW" && result.preStateDigest === result.postStateDigest;
};
const service = new TransactionService({
  currentness: createGitCurrentnessProvider(), adapter: new TransactionMutationAdapter(upstream),
  rollbackRoot: join(TRANSACTION_PROJECT_ROOT, "runtime"), verifier, verificationProfile: "project_test",
});
const runtime = await createGatewayServer({ apiKey: key, upstream, transactionService: service, host: "127.0.0.1", port: 8772 });
const address = await runtime.listen();
console.log(`M04_RUNTIME_READY=${address.url};MODE=${mode}`);
const stop = async () => { try { await runtime.close(); } finally { process.exit(0); } };
process.on("SIGINT", stop); process.on("SIGTERM", stop); setInterval(() => {}, 60000);
'@ | Set-Content -Encoding utf8 $Launcher
@'
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const key = process.env.HAIOS_M04_API_KEY;
const mode = process.argv[2];
const fixtureRoot = process.argv[3];
if (!key || !mode || !fixtureRoot) throw new Error("CLIENT_INPUT_MISSING");
const client = new Client({ name: "haios-m04-qualifier", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8772/mcp"), {
  requestInit: { headers: { "X-API-Key": key } },
});
const parse = (result) => {
  const text = result.content?.filter?.(x => x.type === "text").map(x => x.text ?? "").join("\n") ?? "";
  return text ? JSON.parse(text) : {};
};
const call = async (name, args = {}, expectError = false) => {
  const result = await client.callTool({ name, arguments: args });
  if (!!result.isError !== expectError) throw new Error(`CALL_ERROR_STATE:${name}`);
  return parse(result);
};
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
const sha = (value) => createHash("sha256").update(value, "utf8").digest("hex");
await client.connect(transport);
'@ | Set-Content -Encoding utf8 $ClientScript
@'
const tools = await client.listTools();
const names = tools.tools.map(t => t.name);
if (names.length !== 27) throw new Error(`LIVE_TOOL_COUNT:${names.length}`);
if (["write_file","move_file","delete","unlink","rm","start_process","kill_process"].some(name => names.includes(name))) throw new Error("RAW_TOOL_EXPOSED");
if (mode === "positive") {
  const target = join(fixtureRoot, "safe-remove.txt");
  if (!(await exists(target))) throw new Error("REMOVE_PREIMAGE_MISSING");
  const b = await call("transaction_begin"); const id = b.transactionId;
  await call("transaction_stage_remove", { transactionId:id, path:target, expectedSha256:sha("m04-live-remove") });
  await call("transaction_validate", { transactionId:id });
  const applied = await call("transaction_apply", { transactionId:id });
  if (applied.state !== "PROMOTED" || await exists(target)) throw new Error("SAFE_REMOVE_NOT_PROMOTED");
  await call("delete", { path:target }, true);
  await call("write_file", { path:join(fixtureRoot,"raw.txt"), content:"x" }, true);
  console.log(JSON.stringify({ mode, toolCount:names.length, remove:id, rawMutationDenied:true }));
}
'@ | Add-Content -Encoding utf8 $ClientScript
@'
if (mode === "failure") {
  const target = join(fixtureRoot, "verification-failure.txt");
  if (!(await exists(target))) throw new Error("ROLLBACK_PREIMAGE_MISSING");
  const expected = sha("m04-rollback-preimage");
  const b = await call("transaction_begin"); const id = b.transactionId;
  await call("transaction_stage_remove", { transactionId:id, path:target, expectedSha256:expected });
  await call("transaction_validate", { transactionId:id });
  const failed = await call("transaction_apply", { transactionId:id }, true);
  if (failed.reason !== "VERIFICATION_FAILED_ROLLED_BACK") throw new Error(`WRONG_FAILURE:${failed.reason}`);
  if (!(await exists(target))) throw new Error("ROLLBACK_DID_NOT_RESTORE_REMOVED_FILE");
  const restored = createHash("sha256").update(await readFile(target)).digest("hex");
  if (restored !== expected) throw new Error("ROLLBACK_BYTES_MISMATCH");
  const status = await call("transaction_status", { transactionId:id });
  if (status.state !== "ROLLED_BACK") throw new Error(`ROLLBACK_STATE:${status.state}`);
  console.log(JSON.stringify({ mode, toolCount:names.length, transactionId:id, reason:failed.reason, finalState:status.state, restoredSha256:restored }));
}
await client.close();
'@ | Add-Content -Encoding utf8 $ClientScript

function New-EphemeralKey {
    $Bytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
    return [Convert]::ToBase64String($Bytes).TrimEnd("=").Replace("+","-").Replace("/","_")
}

function Stop-M04Runtime($Process) {
    if ($Process -and -not $Process.HasExited) {
        try { & taskkill.exe /PID $Process.Id /T /F | Out-Null } catch { }
    }
    for ($i=0; $i -lt 30; $i++) { if (-not (Test-Port $Port)) { return }; Start-Sleep -Seconds 1 }
    throw "M04_PORT_8772_CLEANUP_FAILED"
}
$EphemeralKeys = @()
function Invoke-M04Mode([string]$Mode,[string]$StdoutPath,[string]$StderrPath) {
    $Key = New-EphemeralKey
    $script:EphemeralKeys += $Key
    $Process = $null
    try {
        $env:HAIOS_M04_API_KEY = $Key
        $env:HAIOS_M04_VERIFY_MODE = $Mode
        $Process = Start-Process node.exe -ArgumentList @($Launcher) -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath -PassThru -WindowStyle Hidden
        Remove-Item Env:HAIOS_M04_API_KEY,Env:HAIOS_M04_VERIFY_MODE -ErrorAction SilentlyContinue
        $Ready = $false
        for ($i=0; $i -lt 120; $i++) {
            Start-Sleep -Milliseconds 500
            if (Test-Port $Port) { $Ready=$true; break }
            if ($Process.HasExited) { break }
        }
        if (-not $Ready) { throw "LIVE_GATEWAY_START_FAILED:$Mode" }
        $Unauth = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/mcp" -Method GET -SkipHttpErrorCheck -TimeoutSec 10
        if ([int]$Unauth.StatusCode -ne 401) { throw "LIVE_AUTH_NEGATIVE_FAILED:$Mode" }
        $env:HAIOS_M04_API_KEY = $Key
        $ClientErr = Join-Path $EvidenceRoot "client-$Mode.stderr.log"
        $ClientOutput = & node.exe $ClientScript $Mode $FixtureRoot 2> $ClientErr
        $ClientExit = $LASTEXITCODE
        Remove-Item Env:HAIOS_M04_API_KEY -ErrorAction SilentlyContinue
        if ($ClientExit -ne 0) { throw "LIVE_MCP_CLIENT_FAILED:$Mode" }
        return (($ClientOutput | Select-Object -Last 1) | ConvertFrom-Json)
    } finally {
        Remove-Item Env:HAIOS_M04_API_KEY,Env:HAIOS_M04_VERIFY_MODE -ErrorAction SilentlyContinue
        Stop-M04Runtime $Process
    }
}
Write-Host "[4] Live MCP safe-remove promotion qualification"
$PositivePath = Join-Path $FixtureRoot "safe-remove.txt"
[IO.File]::WriteAllBytes($PositivePath, [Text.Encoding]::UTF8.GetBytes("m04-live-remove"))
$PositiveExpectedSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $PositivePath).Hash.ToLowerInvariant()
$Positive = Invoke-M04Mode "positive" $PositiveOut $PositiveErr
if ($Positive.toolCount -ne 27 -or -not $Positive.rawMutationDenied) { throw "LIVE_POSITIVE_CONTRACT_FAILED" }
if (Test-Path -LiteralPath $PositivePath) { throw "LIVE_SAFE_REMOVE_POSTIMAGE_PRESENT" }
Write-Host "LIVE_TOOL_COUNT=27"
Write-Host "LIVE_SAFE_REMOVE_PROMOTION=PASS"
Write-Host "LIVE_RAW_MUTATION_DENIAL=PASS"

Write-Host "[5] Live safe-remove verification-failure rollback qualification"
$FailurePath = Join-Path $FixtureRoot "verification-failure.txt"
[IO.File]::WriteAllBytes($FailurePath, [Text.Encoding]::UTF8.GetBytes("m04-rollback-preimage"))
$FailureExpectedSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $FailurePath).Hash.ToLowerInvariant()
$Failure = Invoke-M04Mode "failure" $FailureOut $FailureErr
if ($Failure.toolCount -ne 27 -or $Failure.reason -ne "VERIFICATION_FAILED_ROLLED_BACK" -or $Failure.finalState -ne "ROLLED_BACK") {
    throw "LIVE_FAILURE_ROLLBACK_CONTRACT_FAILED"
}
if (-not (Test-Path -LiteralPath $FailurePath)) { throw "LIVE_FAILURE_PREIMAGE_NOT_RESTORED" }
$FailureRestoredSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $FailurePath).Hash.ToLowerInvariant()
if ($FailureRestoredSha -ne $FailureExpectedSha -or $Failure.restoredSha256 -ne $FailureExpectedSha) { throw "LIVE_FAILURE_ROLLBACK_BYTES_MISMATCH" }
Write-Host "LIVE_SAFE_REMOVE_VERIFICATION_FAILURE_ROLLBACK=PASS"

$Lifecycle = [ordered]@{
    positive = $Positive
    failure = $Failure
    positive_preimage_sha256 = $PositiveExpectedSha
    positive_postimage_absent = $true
    failure_preimage_sha256 = $FailureExpectedSha
    failure_restored_sha256 = $FailureRestoredSha
}
$Lifecycle | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $EvidenceRoot "live-transaction-lifecycle.json")

Write-Host "[6] Exact qualification-owned fixture/runtime cleanup and transaction reconciliation"
$ExpectedPrefix = (Join-Path $ProjectRoot "runtime\m04-live-").ToLowerInvariant()
if (-not $FixtureRoot.ToLowerInvariant().StartsWith($ExpectedPrefix)) { throw "FIXTURE_ROOT_SCOPE_INVALID" }
$TxnIds = @($Positive.remove,$Failure.transactionId)
foreach ($TxnId in $TxnIds) {
    if ($TxnId -notmatch '^txn_[a-f0-9]{32}$') { throw "LIVE_TRANSACTION_ID_INVALID" }
    if (Test-Path -LiteralPath (Join-Path $ProjectRoot "runtime\$TxnId")) { throw "ROLLBACK_BUNDLE_NOT_CLEANED:$TxnId" }
}
Remove-Item -LiteralPath $FixtureRoot -Recurse -Force
if (Test-Path -LiteralPath $FixtureRoot) { throw "FIXTURE_NAMESPACE_NOT_RESTORED" }
Remove-Item -LiteralPath $RuntimeRoot -Recurse -Force
if (Test-Path -LiteralPath $RuntimeRoot) { throw "QUALIFIER_RUNTIME_NOT_CLEANED" }
$RuntimeResidue = 0
if (Test-Path -LiteralPath $FixtureRoot) { $RuntimeResidue++ }
if (Test-Path -LiteralPath $RuntimeRoot) { $RuntimeResidue++ }
foreach ($TxnId in $TxnIds) { if (Test-Path -LiteralPath (Join-Path $ProjectRoot "runtime\$TxnId")) { $RuntimeResidue++ } }
if ($RuntimeResidue -ne 0) { throw "RUNTIME_RESIDUE:$RuntimeResidue" }
Write-Host "LIVE_FIXTURE_EXACT_PREIMAGE_RESTORED=PASS"
Write-Host "RUNTIME_RESIDUE=0"

Write-Host "[7] Tunnel, Git, manifest and secret post-state"
$TunnelIntegrityEvidence = @()
$TunnelModified = $false
foreach ($TunnelContainer in $TunnelContainers) {
    $Post = Get-TunnelIntegrityDigest $TunnelContainer
    $Match = $TunnelPreDigests[$TunnelContainer] -eq $Post
    if (-not $Match) { $TunnelModified = $true }
    $TunnelIntegrityEvidence += [ordered]@{ name=$TunnelContainer; pre_sha256=$TunnelPreDigests[$TunnelContainer]; post_sha256=$Post; match=$Match }
}
if ($TunnelModified) { throw "TUNNEL_INTEGRITY_DRIFT" }
if ((git status --porcelain).Length -ne 0) { throw "POST_LIVE_WORKTREE_DRIFT" }
if ((git rev-parse HEAD).Trim() -ne $Head) { throw "POST_LIVE_HEAD_DRIFT" }
if ((& git -C $ProjectRoot rev-parse HEAD).Trim() -ne $CanonicalHead) { throw "CANONICAL_PROJECT_HEAD_DRIFT" }
if ((& git -C $ProjectRoot status --porcelain).Length -ne 0) { throw "CANONICAL_PROJECT_WORKTREE_DRIFT" }
$AfterPath = Join-Path $EvidenceRoot "source-manifest-post-live.txt"
$ManifestDigestAfter = Write-DeterministicSourceManifest $AfterPath
if ($ManifestDigestAfter -ne $ManifestDigest) { throw "SOURCE_MANIFEST_DRIFT" }

$SecretLeakDetected = $false
foreach ($Key in $EphemeralKeys) {
    if ([string]::IsNullOrWhiteSpace($Key)) { continue }
    foreach ($File in (Get-ChildItem $EvidenceRoot -File -ErrorAction SilentlyContinue)) {
        if ([IO.File]::ReadAllText($File.FullName).Contains($Key)) { $SecretLeakDetected = $true }
    }
}
$EphemeralKeys = @()
if ($SecretLeakDetected) { throw "EPHEMERAL_API_KEY_PERSISTED" }
Write-Host "TUNNEL_INTEGRITY=PASS"
Write-Host "SOURCE_MANIFEST_POST_LIVE=PASS"
Write-Host "UNAUTHORIZED_MUTATIONS=0"
Write-Host "SECRETS_PERSISTED=FALSE"

if (-not (Test-Port 8768)) { throw "POST_SECURE_MCP_8768_REGRESSION" }
if (-not (Test-Port 8769)) { throw "POST_OPERATOR_MCP_8769_REGRESSION" }
if (Test-Port 8772) { throw "POST_M04_PORT_8772_NOT_FREE" }
$Result = [ordered]@{
    mission = "HAIOS_DESKTOP_CONTROL_PLANE_R1_M04_SAFE_REMOVE"
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
    live_tool_count = 27
    live_safe_remove_promotion = "PASS"
    live_safe_remove_verification_failure_rollback = "PASS"
    live_fixture_exact_preimage_restored = "PASS"
    runtime_residue = 0
    raw_mutation_denial = "PASS"
    tracked_source_mutation_count = 0
    unauthorized_mutations = 0
    secrets_persisted = $false
    tunnel_integrity = @($TunnelIntegrityEvidence)
    tunnel_modified = $TunnelModified
    read_capability = "QUALIFIED"
    execute_capability = "QUALIFIED"
    mutate_capability = "QUALIFIED_CANDIDATE_WITH_SAFE_REMOVE"
    destructive_capability = "LOCKED"
    independent_verification = "PENDING"
    terminal = "HAIOS_DESKTOP_CONTROL_PLANE_R1_M04_READY_FOR_INDEPENDENT_VERIFICATION"
}
$ResultPath = Join-Path $EvidenceRoot "m04-qualification-result.json"
$Result | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 $ResultPath
$Handoff = [ordered]@{
    mission = $Result.mission
    run_id = $RunId
    head = $Head
    source_manifest_digest = $ManifestDigest
    review_mode = "READ_ONLY_INDEPENDENT"
    rerun_unchanged_tests = $false
    required_checks = @(
        "HEAD_MATCH","MANIFEST_MATCH","CANONICAL_PROJECT_IDENTITY_MATCH","MUTATE_SURFACE_EXACT_27",
        "RAW_DESTRUCTIVE_ABSENT","PROJECT_REALPATH_BOUNDARY","REGULAR_FILE_ONLY","EXPECTED_HASH_BOUND",
        "QUARANTINE_OWNERSHIP","SAFE_REMOVE_PROMOTION","VERIFICATION_FAILURE_EXACT_ROLLBACK",
        "ROLLBACK_CONFLICT_FAIL_CLOSED","M01_M02_M03_INVARIANTS_PRESERVED","TUNNEL_INTEGRITY",
        "RUNTIME_CLEANUP","SECRETS_PERSISTED_FALSE"
    )
    allowed_verdicts = @("PASS","BLOCKED")
}
$Handoff | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $EvidenceRoot "independent-review-handoff.json")
Write-Host "RESULT_PATH=$ResultPath"
Write-Host "HAIOS_DESKTOP_CONTROL_PLANE_R1_M04_READY_FOR_INDEPENDENT_VERIFICATION" -ForegroundColor Green

