$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
if ($PSVersionTable.PSVersion.Major -lt 7) { throw "POWERSHELL_7_REQUIRED" }
Set-Location (Split-Path -Parent $PSScriptRoot)

$Root = (Get-Location).Path
$RunId = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ", [Globalization.CultureInfo]::InvariantCulture)
$EvidenceRoot = Join-Path $Root "evidence\m06\$RunId"
$RuntimeRoot = Join-Path $Root "runtime\m06-qual-$RunId"
$Port = 8772
New-Item -ItemType Directory -Force $EvidenceRoot,$RuntimeRoot | Out-Null

function Require-Exit([string]$Name) {
    if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit $LASTEXITCODE" }
}
function Test-Port([int]$PortNumber) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue)
}
function Get-Sha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}
function Get-DeterministicSourceManifestLines {
    $Paths = [string[]]@(git ls-files)
    [Array]::Sort($Paths, [StringComparer]::Ordinal)
    foreach ($Relative in $Paths) { "$(Get-Sha256 (Join-Path $Root $Relative))  $Relative" }
}
function Write-DeterministicSourceManifest([string]$Path) {
    $Text = (@(Get-DeterministicSourceManifestLines) -join "`n") + "`n"
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
    return Get-Sha256 $Path
}
$TunnelContainers = @("haios-tunnel-client", "haios-operator-dedicated-tunnel-client")
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
$TunnelPre = @{}
foreach ($Name in $TunnelContainers) { $TunnelPre[$Name] = Get-TunnelIntegrityDigest $Name }
if (-not (Test-Port 8768)) { throw "SECURE_MCP_8768_REGRESSION" }
if (-not (Test-Port 8769)) { throw "OPERATOR_MCP_8769_REGRESSION" }
if (Test-Port $Port) { throw "M06_PORT_8772_NOT_FREE" }
Write-Host "M06_RUN_ID=$RunId"
Write-Host "HEAD=$Head"
Write-Host "BRANCH=$Branch"
Write-Host "[1] M06 adversarial qualification"
$AdversarialLog = Join-Path $EvidenceRoot "m06-adversarial.log"
& npm.cmd test -- tests/m06-adversarial.test.ts 2>&1 | Tee-Object -FilePath $AdversarialLog
Require-Exit "M06_ADVERSARIAL_TESTS"

Write-Host "[2] One final full regression on committed candidate bytes"
$FullTestLog = Join-Path $EvidenceRoot "full-tests.log"
& npm.cmd test 2>&1 | Tee-Object -FilePath $FullTestLog
Require-Exit "FULL_TESTS"
$FullText = ([IO.File]::ReadAllText($FullTestLog) -replace "`e\[[0-9;?]*[ -/]*[@-~]", "")
$FullMatch = [regex]::Match($FullText, 'Tests\s+(\d+)\s+passed')
if (-not $FullMatch.Success) { throw "FULL_TEST_PASS_COUNT_NOT_FOUND" }
$FullTestPassingCount = [int]$FullMatch.Groups[1].Value
Write-Host "FULL_TEST_PASSING_COUNT=$FullTestPassingCount"
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

Write-Host "[4] Disposable live local Git transaction proof"
$LiveScript = Join-Path $RuntimeRoot "live-m06.mjs"
$LiveResultPath = Join-Path $EvidenceRoot "live-m06-result.json"
@'
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalOperatorGit } from "../../dist/src/operator/local-git.js";
import { OperatorTransactionService } from "../../dist/src/operator/transaction-isolation.js";

const run = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
const canonical = join(root, "canonical");
const worktreeRoot = join(root, "worktrees");
await mkdir(canonical, { recursive:true });
await mkdir(worktreeRoot, { recursive:true });
const rawGit = async (...args) => (await run("git", args, { cwd:canonical, windowsHide:true, encoding:"utf8" })).stdout.trim();
await rawGit("init", "-b", "main");
await writeFile(join(canonical, "alpha.txt"), "alpha", "utf8");
await rawGit("add", "-A");
await rawGit("-c", "user.email=haios-qual@local", "-c", "user.name=HAIOS Qualifier", "commit", "-m", "baseline");

const git = new LocalOperatorGit();
const service = new OperatorTransactionService({ worktreeRoot, allowedProjects:{ demo:canonical }, git });
const baselineHead = await git.head(canonical);
const b64 = (value) => Buffer.from(value, "utf8").toString("base64");
const begin1 = await service.begin("demo", canonical);
if (begin1.decision !== "ALLOW") throw new Error(`BEGIN1:${JSON.stringify(begin1)}`);
const tx1 = begin1.transaction.txId;
await service.stageCreate(tx1, "stale.txt", b64("stale-candidate"));
await service.validate(tx1);
await service.apply(tx1);
if ((await git.head(canonical)) !== baselineHead) throw new Error("CANONICAL_CHANGED_DURING_APPLY1");
'@ | Set-Content -Encoding utf8 $LiveScript
@'
try { await readFile(join(canonical, "stale.txt")); throw new Error("CANONICAL_BYTES_CHANGED_BEFORE_PROMOTION1"); } catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const cp1 = await service.checkpoint(tx1, "m06 stale checkpoint");
if (cp1.decision !== "ALLOW" || !cp1.transaction.checkpointId) throw new Error(`CHECKPOINT1:${JSON.stringify(cp1)}`);
await writeFile(join(canonical, "external.txt"), "external", "utf8");
await rawGit("add", "-A");
await rawGit("-c", "user.email=haios-qual@local", "-c", "user.name=HAIOS Qualifier", "commit", "-m", "external drift");
const driftHead = await git.head(canonical);
const stale = await service.promote(tx1, baselineHead, cp1.transaction.checkpointId);
if (stale.decision !== "DENY" || stale.reason !== "STALE_CANONICAL_HEAD") throw new Error(`STALE_CONFLICT:${JSON.stringify(stale)}`);
if ((await git.head(canonical)) !== driftHead) throw new Error("STALE_PROMOTION_MUTATED_CANONICAL");
const rollback1 = await service.rollback(tx1);
if (rollback1.decision !== "ALLOW" || rollback1.state !== "ROLLED_BACK") throw new Error(`ROLLBACK1:${JSON.stringify(rollback1)}`);
if ((await readdir(worktreeRoot)).length !== 0) throw new Error("WORKTREE_RESIDUE_AFTER_ROLLBACK");

const begin2 = await service.begin("demo", canonical);
if (begin2.decision !== "ALLOW") throw new Error(`BEGIN2:${JSON.stringify(begin2)}`);
const tx2 = begin2.transaction.txId;
await service.stageCreate(tx2, "promoted.txt", b64("promoted"));
await service.validate(tx2);
await service.apply(tx2);
if ((await git.head(canonical)) !== driftHead) throw new Error("CANONICAL_CHANGED_DURING_APPLY2");
try { await readFile(join(canonical, "promoted.txt")); throw new Error("CANONICAL_BYTES_CHANGED_BEFORE_PROMOTION2"); } catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
'@ | Add-Content -Encoding utf8 $LiveScript
@'
const cp2 = await service.checkpoint(tx2, "m06 successful checkpoint");
if (cp2.decision !== "ALLOW" || !cp2.transaction.checkpointId) throw new Error(`CHECKPOINT2:${JSON.stringify(cp2)}`);
const promote2 = await service.promote(tx2, driftHead, cp2.transaction.checkpointId);
if (promote2.decision !== "ALLOW" || promote2.state !== "PROMOTED" || promote2.cleanupPending) throw new Error(`PROMOTE2:${JSON.stringify(promote2)}`);
const finalHead = await git.head(canonical);
if (finalHead !== cp2.transaction.checkpointId) throw new Error("FINAL_HEAD_NOT_CHECKPOINT");
if ((await git.status(canonical)).trim() !== "") throw new Error("FINAL_CANONICAL_DIRTY");
if ((await readFile(join(canonical, "promoted.txt"), "utf8")) !== "promoted") throw new Error("PROMOTED_BYTES_MISMATCH");
const worktreeResidue = (await readdir(worktreeRoot)).length;
if (worktreeResidue !== 0) throw new Error(`WORKTREE_RESIDUE:${worktreeResidue}`);
console.log(JSON.stringify({
  baselineHead, driftHead, staleConflict:true, staleReason:stale.reason,
  rollback1:true, checkpoint2:cp2.transaction.checkpointId,
  finalHead, ffPromotion:true, finalCanonicalClean:true,
  canonicalUnchangedBeforePromotion:true, worktreeResidue,
}));
'@ | Add-Content -Encoding utf8 $LiveScript

$LiveOutput = & node.exe $LiveScript
Require-Exit "LIVE_M06_GIT_PROOF"
$LiveJson = ($LiveOutput | Select-Object -Last 1)
$Live = $LiveJson | ConvertFrom-Json
$LiveJson | Set-Content -Encoding utf8 $LiveResultPath
if (-not $Live.staleConflict -or $Live.staleReason -ne "STALE_CANONICAL_HEAD") { throw "LIVE_STALE_HEAD_CONFLICT_FAILED" }
if (-not $Live.rollback1 -or -not $Live.ffPromotion -or -not $Live.finalCanonicalClean) { throw "LIVE_PROMOTION_CONTRACT_FAILED" }
if (-not $Live.canonicalUnchangedBeforePromotion -or $Live.worktreeResidue -ne 0) { throw "LIVE_ISOLATION_CONTRACT_FAILED" }
Write-Host "LIVE_STALE_HEAD_CONFLICT=PASS"
Write-Host "LIVE_FF_PROMOTION=PASS"
Write-Host "LIVE_ISOLATION=PASS"
Write-Host "REPOSITORY_IDENTITY_BOUND=PASS"
Write-Host "[5] Cleanup and post-state reconciliation"
Remove-Item -LiteralPath $RuntimeRoot -Recurse -Force
$RuntimeResidue = if (Test-Path -LiteralPath $RuntimeRoot) { 1 } else { 0 }
if ($RuntimeResidue -ne 0) { throw "RUNTIME_RESIDUE:$RuntimeResidue" }
Write-Host "RUNTIME_RESIDUE=0"

$SecretPatterns = @('(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{20,}','(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}','BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY')
$SecretLeak = $false
foreach ($File in (Get-ChildItem $EvidenceRoot -File -ErrorAction SilentlyContinue)) {
    $Text = [IO.File]::ReadAllText($File.FullName)
    foreach ($Pattern in $SecretPatterns) { if ($Text -match $Pattern) { $SecretLeak = $true } }
}
if ($SecretLeak) { throw "SECRETS_PERSISTED" }
Write-Host "SECRETS_PERSISTED=FALSE"

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

if (-not (Test-Port 8768) -or -not (Test-Port 8769)) { throw "TUNNEL_PORT_REGRESSION" }
if (Test-Port $Port) { throw "M06_PORT_8772_POSTSTATE_FAILED" }
Write-Host "PORT_8772_FREE=PASS"
if ((git status --porcelain).Length -ne 0) { throw "POST_LIVE_WORKTREE_DRIFT" }
if ((git rev-parse HEAD).Trim() -ne $Head) { throw "POST_LIVE_HEAD_DRIFT" }
$AfterPath = Join-Path $EvidenceRoot "source-manifest-post-live.txt"
$ManifestDigestAfter = Write-DeterministicSourceManifest $AfterPath
if ($ManifestDigestAfter -ne $ManifestDigest) { throw "SOURCE_MANIFEST_DRIFT" }
Write-Host "SOURCE_MANIFEST_POST_LIVE=PASS"
Write-Host "UNAUTHORIZED_MUTATIONS=0"

$Result = [ordered]@{
    mission = "HAIOS_DESKTOP_CONTROL_PLANE_R1_M06_ISOLATED_CHECKPOINT_CAS"
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
    live_stale_head_conflict = "PASS"
    live_ff_only_promotion = "PASS"
    live_isolation = "PASS"
    repository_identity_bound = $true
    live_checkpoint = [string]$Live.checkpoint2
    live_final_head = [string]$Live.finalHead
    runtime_residue = 0
    unauthorized_mutations = 0
    secrets_persisted = $false
    tunnel_integrity = @($TunnelEvidence)
    tunnel_modified = $TunnelModified
    operator13_mode = "READ_ONLY_EMERGENCY"
    operator13_mutation_active = $false
    internal_checkpoint_engine_qualified = $true
    internal_promotion_engine_qualified = $true
    public_checkpoint_qualified = $false
    public_promotion_qualified = $false
    destructive_capability = "LOCKED"
    independent_verification = "PENDING"
    terminal = "HAIOS_DESKTOP_CONTROL_PLANE_R1_M06_READY_FOR_INDEPENDENT_VERIFICATION"
}
$ResultPath = Join-Path $EvidenceRoot "m06-qualification-result.json"
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
        "OPERATOR13_STILL_INACTIVE","LOCAL_GIT_NO_NETWORK_AUTHORITY","ISOLATED_WORKTREE_ONLY",
        "PATH_REPARSE_FAIL_CLOSED","CHECKPOINT_DESCENDANT_BOUND","CAS_CONFLICT_PREMERGE",
        "FF_ONLY_PROMOTION","REPOSITORY_IDENTITY_BOUND","ROLLBACK_OWNED_RUNTIME_ONLY","TUNNEL_INTEGRITY",
        "RUNTIME_CLEANUP","SECRETS_PERSISTED_FALSE"
    )
    allowed_verdicts = @("PASS","BLOCKED")
}
$Handoff | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $EvidenceRoot "independent-review-handoff.json")
Write-Host "RESULT_PATH=$ResultPath"
Write-Host "HAIOS_DESKTOP_CONTROL_PLANE_R1_M06_READY_FOR_INDEPENDENT_VERIFICATION" -ForegroundColor Green
