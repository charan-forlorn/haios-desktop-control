$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
Set-Location (Split-Path -Parent $PSScriptRoot)

$Root = (Get-Location).Path
$RunId = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ", [Globalization.CultureInfo]::InvariantCulture)
$EvidenceRoot = Join-Path $Root "evidence\m03\$RunId"
$RuntimeRoot = Join-Path $Root "runtime\m03-qual-$RunId"
$FixtureRoot = Join-Path $Root "runtime\m03-live-$RunId"
$Port = 8772
New-Item -ItemType Directory -Force $EvidenceRoot,$RuntimeRoot,$FixtureRoot | Out-Null

function Test-Port([int]$PortNumber) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue)
}

function Require-Exit([string]$Name) {
    if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit $LASTEXITCODE" }
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

Write-Host "M03_RUN_ID=$RunId"
if ((git status --porcelain).Length -ne 0) { throw "WORKTREE_NOT_CLEAN" }
$Head = (git rev-parse HEAD).Trim()
$Branch = (git branch --show-current).Trim()
$TunnelPreDigests = @{}
foreach ($TunnelContainer in $TunnelContainers) {
    $TunnelPreDigests[$TunnelContainer] = Get-TunnelIntegrityDigest $TunnelContainer
}
Write-Host "HEAD=$Head"
Write-Host "BRANCH=$Branch"
Write-Host "TUNNEL_PREIMAGE=PASS"

Write-Host "[1] Focused adversarial qualification"
$AdversarialLog = Join-Path $EvidenceRoot "m03-adversarial.log"
& npm.cmd test -- tests/m03-adversarial.test.ts 2>&1 | Tee-Object -FilePath $AdversarialLog
Require-Exit "M03_ADVERSARIAL_TESTS"

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
$ManifestLines = @()
foreach ($Relative in (git ls-files | Sort-Object)) {
    $Absolute = Join-Path $Root $Relative
    $Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Absolute).Hash.ToLowerInvariant()
    $ManifestLines += "$Hash  $Relative"
}
$ManifestLines | Set-Content -Encoding utf8 $ManifestPath
$ManifestDigest = (Get-FileHash -Algorithm SHA256 $ManifestPath).Hash.ToLowerInvariant()
Write-Host "SOURCE_MANIFEST_DIGEST=$ManifestDigest"

if ((git status --porcelain).Length -ne 0) { throw "POST_TEST_WORKTREE_DRIFT" }
if ((git rev-parse HEAD).Trim() -ne $Head) { throw "POST_TEST_HEAD_DRIFT" }
if (Test-Port 8771) { throw "Q2R1_PORT_8771_NOT_FREE" }
if (Test-Port $Port) { throw "M03_PORT_8772_NOT_FREE" }
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
const key = process.env.HAIOS_M03_API_KEY;
const mode = process.env.HAIOS_M03_VERIFY_MODE ?? "pass";
if (!key) throw new Error("HAIOS_M03_API_KEY missing");
const upstream = await DesktopCommanderClient.connect();
const verifier = mode === "fail" ? async () => false : async () => {
  const result = await dispatchExecuteTool("project_test", {}, { upstream });
  return result.decision === "ALLOW" && result.preStateDigest === result.postStateDigest;
};
const service = new TransactionService({
  currentness: createGitCurrentnessProvider(), adapter: new TransactionMutationAdapter(upstream),
  rollbackRoot: join(TRANSACTION_PROJECT_ROOT, "runtime"), verifier, verificationProfile: "project_test",
});
const runtime = await createGatewayServer({ apiKey: key, upstream, transactionService: service, host: "127.0.0.1", port: 8772 });
const address = await runtime.listen();
console.log(`M03_RUNTIME_READY=${address.url};MODE=${mode}`);
const stop = async () => { try { await runtime.close(); } finally { process.exit(0); } };
process.on("SIGINT", stop); process.on("SIGTERM", stop); setInterval(() => {}, 60000);
'@ | Set-Content -Encoding utf8 $Launcher
@'
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const key = process.env.HAIOS_M03_API_KEY;
const mode = process.argv[2];
const fixtureRoot = process.argv[3];
if (!key || !mode || !fixtureRoot) throw new Error("CLIENT_INPUT_MISSING");
const client = new Client({ name: "haios-m03-qualifier", version: "1.0.0" });
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
if (names.length !== 26) throw new Error(`LIVE_TOOL_COUNT:${names.length}`);
if (names.includes("write_file") || names.includes("move_file") || names.includes("start_process")) throw new Error("RAW_TOOL_EXPOSED");
if (mode === "positive") {
  const created = join(fixtureRoot, "created.txt");
  const moved = join(fixtureRoot, "moved.txt");
  const b1 = await call("transaction_begin"); const id1 = b1.transactionId;
  await call("transaction_stage_create", { transactionId:id1, path:created, content:"live-v1" });
  await call("transaction_validate", { transactionId:id1 });
  const a1 = await call("transaction_apply", { transactionId:id1 });
  if (a1.state !== "PROMOTED") throw new Error("CREATE_NOT_PROMOTED");
  const b2 = await call("transaction_begin"); const id2 = b2.transactionId;
  await call("transaction_stage_replace", { transactionId:id2, path:created, expectedSha256:sha("live-v1"), content:"live-v2" });
  await call("transaction_validate", { transactionId:id2 });
  const a2 = await call("transaction_apply", { transactionId:id2 });
  if (a2.state !== "PROMOTED") throw new Error("REPLACE_NOT_PROMOTED");
  const b3 = await call("transaction_begin"); const id3 = b3.transactionId;
  await call("transaction_stage_move", { transactionId:id3, sourcePath:created, destinationPath:moved });
  await call("transaction_validate", { transactionId:id3 });
  const a3 = await call("transaction_apply", { transactionId:id3 });
  if (a3.state !== "PROMOTED" || await exists(created) || !(await exists(moved))) throw new Error("MOVE_NOT_PROMOTED");
  await call("write_file", { path:join(fixtureRoot,"raw.txt"), content:"x" }, true);
  console.log(JSON.stringify({ mode, toolCount:names.length, create:id1, replace:id2, move:id3, rawMutationDenied:true }));
}
'@ | Add-Content -Encoding utf8 $ClientScript
@'
if (mode === "failure") {
  const target = join(fixtureRoot, "verification-failure.txt");
  const b = await call("transaction_begin"); const id = b.transactionId;
  await call("transaction_stage_create", { transactionId:id, path:target, content:"temporary" });
  await call("transaction_validate", { transactionId:id });
  const failed = await call("transaction_apply", { transactionId:id }, true);
  if (failed.reason !== "VERIFICATION_FAILED_ROLLED_BACK") throw new Error(`WRONG_FAILURE:${failed.reason}`);
  if (await exists(target)) throw new Error("ROLLBACK_DID_NOT_REMOVE_CREATED_FILE");
  const status = await call("transaction_status", { transactionId:id });
  if (status.state !== "ROLLED_BACK") throw new Error(`ROLLBACK_STATE:${status.state}`);
  console.log(JSON.stringify({ mode, toolCount:names.length, transactionId:id, reason:failed.reason, finalState:status.state }));
}
await client.close();
'@ | Add-Content -Encoding utf8 $ClientScript

function New-EphemeralKey {
    $Bytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
    return [Convert]::ToBase64String($Bytes).TrimEnd("=").Replace("+","-").Replace("/","_")
}

function Stop-M03Runtime($Process) {
    if ($Process -and -not $Process.HasExited) {
        try { & taskkill.exe /PID $Process.Id /T /F | Out-Null } catch { }
    }
    for ($i=0; $i -lt 30; $i++) { if (-not (Test-Port $Port)) { return }; Start-Sleep -Seconds 1 }
    throw "M03_PORT_8772_CLEANUP_FAILED"
}
$EphemeralKeys = @()
function Invoke-M03Mode([string]$Mode,[string]$StdoutPath,[string]$StderrPath) {
    $Key = New-EphemeralKey
    $script:EphemeralKeys += $Key
    $Process = $null
    try {
        $env:HAIOS_M03_API_KEY = $Key
        $env:HAIOS_M03_VERIFY_MODE = $Mode
        $Process = Start-Process node.exe -ArgumentList @($Launcher) -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath -PassThru -WindowStyle Hidden
        Remove-Item Env:HAIOS_M03_API_KEY,Env:HAIOS_M03_VERIFY_MODE -ErrorAction SilentlyContinue
        $Ready = $false
        for ($i=0; $i -lt 120; $i++) {
            Start-Sleep -Milliseconds 500
            if (Test-Port $Port) { $Ready=$true; break }
            if ($Process.HasExited) { break }
        }
        if (-not $Ready) { throw "LIVE_GATEWAY_START_FAILED:$Mode" }
        $Unauth = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/mcp" -Method GET -SkipHttpErrorCheck -TimeoutSec 10
        if ([int]$Unauth.StatusCode -ne 401) { throw "LIVE_AUTH_NEGATIVE_FAILED:$Mode" }
        $env:HAIOS_M03_API_KEY = $Key
        $ClientErr = Join-Path $EvidenceRoot "client-$Mode.stderr.log"
        $ClientOutput = & node.exe $ClientScript $Mode $FixtureRoot 2> $ClientErr
        $ClientExit = $LASTEXITCODE
        Remove-Item Env:HAIOS_M03_API_KEY -ErrorAction SilentlyContinue
        if ($ClientExit -ne 0) { throw "LIVE_MCP_CLIENT_FAILED:$Mode" }
        return (($ClientOutput | Select-Object -Last 1) | ConvertFrom-Json)
    } finally {
        Remove-Item Env:HAIOS_M03_API_KEY,Env:HAIOS_M03_VERIFY_MODE -ErrorAction SilentlyContinue
        Stop-M03Runtime $Process
    }
}
Write-Host "[4] Live MCP create/replace/move qualification"
$Positive = Invoke-M03Mode "positive" $PositiveOut $PositiveErr
if ($Positive.toolCount -ne 26 -or -not $Positive.rawMutationDenied) { throw "LIVE_POSITIVE_CONTRACT_FAILED" }
$MovedPath = Join-Path $FixtureRoot "moved.txt"
if (-not (Test-Path -LiteralPath $MovedPath)) { throw "LIVE_MOVE_POSTIMAGE_MISSING" }
$MovedText = [IO.File]::ReadAllText($MovedPath)
if ($MovedText -ne "live-v2") { throw "LIVE_REPLACE_MOVE_CONTENT_MISMATCH" }
Write-Host "LIVE_TOOL_COUNT=26"
Write-Host "LIVE_CREATE_REPLACE_MOVE=PASS"
Write-Host "LIVE_RAW_MUTATION_DENIAL=PASS"

Write-Host "[5] Live verification-failure rollback qualification"
$Failure = Invoke-M03Mode "failure" $FailureOut $FailureErr
if ($Failure.toolCount -ne 26 -or $Failure.reason -ne "VERIFICATION_FAILED_ROLLED_BACK" -or $Failure.finalState -ne "ROLLED_BACK") {
    throw "LIVE_FAILURE_ROLLBACK_CONTRACT_FAILED"
}
if (Test-Path -LiteralPath (Join-Path $FixtureRoot "verification-failure.txt")) { throw "LIVE_FAILURE_ARTIFACT_REMAINS" }
Write-Host "LIVE_VERIFICATION_FAILURE_ROLLBACK=PASS"

$MovedSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $MovedPath).Hash.ToLowerInvariant()
$Lifecycle = [ordered]@{
    positive = $Positive
    failure = $Failure
    moved_path_relative = "runtime/m03-live-$RunId/moved.txt"
    moved_sha256 = $MovedSha
    rollback_failure_file_absent = $true
}
$Lifecycle | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $EvidenceRoot "live-transaction-lifecycle.json")
Write-Host "[6] Exact fixture cleanup and recovery-bundle reconciliation"
$ExpectedPrefix = (Join-Path $Root "runtime\m03-live-").ToLowerInvariant()
if (-not $FixtureRoot.ToLowerInvariant().StartsWith($ExpectedPrefix)) { throw "FIXTURE_ROOT_SCOPE_INVALID" }
Get-ChildItem -LiteralPath $FixtureRoot -Force | Remove-Item -Recurse -Force
if (@(Get-ChildItem -LiteralPath $FixtureRoot -Force).Count -ne 0) { throw "FIXTURE_NAMESPACE_NOT_RESTORED" }
$TxnIds = @($Positive.create,$Positive.replace,$Positive.move,$Failure.transactionId)
foreach ($TxnId in $TxnIds) {
    if ($TxnId -notmatch '^txn_[a-f0-9]{32}$') { throw "LIVE_TRANSACTION_ID_INVALID" }
    if (Test-Path -LiteralPath (Join-Path $Root "runtime\$TxnId")) { throw "ROLLBACK_BUNDLE_NOT_CLEANED:$TxnId" }
}
Write-Host "LIVE_FIXTURE_EXACT_PREIMAGE_RESTORED=PASS"

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
$ManifestLinesAfter = @()
foreach ($Relative in (git ls-files | Sort-Object)) {
    $Absolute = Join-Path $Root $Relative
    $Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Absolute).Hash.ToLowerInvariant()
    $ManifestLinesAfter += "$Hash  $Relative"
}
$AfterPath = Join-Path $EvidenceRoot "source-manifest-post-live.txt"
$ManifestLinesAfter | Set-Content -Encoding utf8 $AfterPath
$ManifestDigestAfter = (Get-FileHash -Algorithm SHA256 $AfterPath).Hash.ToLowerInvariant()
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
if (Test-Port 8772) { throw "POST_M03_PORT_8772_NOT_FREE" }
$Result = [ordered]@{
    mission = "HAIOS_DESKTOP_CONTROL_PLANE_R1_M03_TRANSACTIONAL_MUTATE"
    run_id = $RunId
    head = $Head
    branch = $Branch
    source_manifest_digest = $ManifestDigest
    source_manifest_post_live_digest = $ManifestDigestAfter
    adversarial_tests = "PASS"
    full_tests = "PASS"
    full_test_passing_count = $FullTestPassingCount
    typecheck = "PASS"
    build = "PASS"
    live_tool_count = 26
    live_create_replace_move = "PASS"
    live_verification_failure_rollback = "PASS"
    live_fixture_exact_preimage_restored = "PASS"
    raw_mutation_denial = "PASS"
    tracked_source_mutation_count = 0
    unauthorized_mutations = 0
    secrets_persisted = $false
    tunnel_integrity = @($TunnelIntegrityEvidence)
    tunnel_modified = $TunnelModified
    read_capability = "QUALIFIED"
    execute_capability = "QUALIFIED"
    mutate_capability = "QUALIFIED_CANDIDATE"
    destructive_capability = "LOCKED"
    independent_verification = "PENDING"
    terminal = "HAIOS_DESKTOP_CONTROL_PLANE_R1_M03_READY_FOR_INDEPENDENT_VERIFICATION"
}
$ResultPath = Join-Path $EvidenceRoot "m03-qualification-result.json"
$Result | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 $ResultPath
$Handoff = [ordered]@{
    mission = $Result.mission
    run_id = $RunId
    head = $Head
    source_manifest_digest = $ManifestDigest
    review_mode = "READ_ONLY_INDEPENDENT"
    rerun_unchanged_tests = $false
    required_checks = @(
        "HEAD_MATCH","MANIFEST_MATCH","MUTATE_SURFACE_EXACT","RAW_MUTATION_ABSENT",
        "PROJECT_REALPATH_BOUNDARY","VERIFICATION_FAILURE_ROLLBACK","PROMOTION_AFTER_VERIFIED_ONLY",
        "M01_M02_INVARIANTS_PRESERVED","TUNNEL_INTEGRITY","SECRETS_PERSISTED_FALSE"
    )
    allowed_verdicts = @("PASS","BLOCKED")
}
$Handoff | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $EvidenceRoot "independent-review-handoff.json")
Write-Host "RESULT_PATH=$ResultPath"
Write-Host "HAIOS_DESKTOP_CONTROL_PLANE_R1_M03_READY_FOR_INDEPENDENT_VERIFICATION" -ForegroundColor Green
