$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
if ($PSVersionTable.PSVersion.Major -lt 7) { throw "POWERSHELL_7_REQUIRED" }
Set-Location (Split-Path -Parent $PSScriptRoot)
$Root = (Get-Location).Path
$RunId = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ", [Globalization.CultureInfo]::InvariantCulture)
$EvidenceRoot = Join-Path $Root "evidence\m07\$RunId"
$RuntimeRoot = Join-Path $Root "runtime\m07-qual-$RunId"
$Port = 8772
$ParentHead = "7b8e39f92e8444264a56a8f0e214095a25bf9016"
$Image = "haios-operator-sandbox-node@sha256:4c1909633b4c7c6e8dfce3e7994bacaf81ac30808a055d4ba790e9b7c366dcfe"
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
function Get-M07ContainerResidue {
    $Ids = @(& docker.exe ps -aq --filter "label=haios.m07.owner=m07" 2>$null)
    if ($LASTEXITCODE -ne 0) { throw "DOCKER_CONTAINER_RESIDUE_QUERY_FAILED" }
    return @($Ids | Where-Object { $_ -and $_.Trim().Length -gt 0 })
}
function Get-M07NetworkResidue {
    $Ids = @(& docker.exe network ls -q --filter "label=haios.m07.owner=m07" 2>$null)
    if ($LASTEXITCODE -ne 0) { throw "DOCKER_NETWORK_RESIDUE_QUERY_FAILED" }
    return @($Ids | Where-Object { $_ -and $_.Trim().Length -gt 0 })
}

if ((git status --porcelain).Length -ne 0) { throw "WORKTREE_NOT_CLEAN" }
$Head = (git rev-parse HEAD).Trim()
$Branch = (git branch --show-current).Trim()
& git merge-base --is-ancestor $ParentHead $Head
Require-Exit "M06_PARENT_ANCESTRY"
$TunnelPre = @{}
foreach ($Name in $TunnelContainers) { $TunnelPre[$Name] = Get-TunnelIntegrityDigest $Name }
if (-not (Test-Port 8768)) { throw "SECURE_MCP_8768_REGRESSION" }
if (-not (Test-Port 8769)) { throw "OPERATOR_MCP_8769_REGRESSION" }
if (Test-Port $Port) { throw "M07_PORT_8772_NOT_FREE" }
if ((Get-M07ContainerResidue).Count -ne 0 -or (Get-M07NetworkResidue).Count -ne 0) {
    throw "M07_PREEXISTING_DOCKER_RESIDUE"
}
$ImageInspect = (& docker.exe image inspect $Image | ConvertFrom-Json)[0]
if ($LASTEXITCODE -ne 0 -or -not $ImageInspect) { throw "M07_PINNED_IMAGE_UNAVAILABLE" }
$ExpectedImageId = "sha256:4c1909633b4c7c6e8dfce3e7994bacaf81ac30808a055d4ba790e9b7c366dcfe"
if ($ImageInspect.Id -ne $ExpectedImageId) { throw "M07_IMAGE_ID_DRIFT" }
if ($ImageInspect.Config.User -ne "node") { throw "M07_IMAGE_USER_DRIFT" }
if ($ImageInspect.Config.Env -notcontains "NODE_VERSION=22.23.2") { throw "M07_NODE_VERSION_DRIFT" }
$DockerClient = (& docker.exe version --format '{{.Client.Version}}').Trim()
$DockerServer = (& docker.exe version --format '{{.Server.Version}}').Trim()
Require-Exit "DOCKER_VERSION"
$RegistrySha = Get-Sha256 (Join-Path $Root "task-registry.m07.json")
$EffectsSha = Get-Sha256 (Join-Path $Root "task-effects.m07.json")
Write-Host "M07_RUN_ID=$RunId"
Write-Host "HEAD=$Head"
Write-Host "BRANCH=$Branch"
Write-Host "REGISTRY_SHA256=$RegistrySha"
Write-Host "EFFECT_POLICY_SHA256=$EffectsSha"
Write-Host "[1] M07 adversarial qualification"
$AdversarialLog = Join-Path $EvidenceRoot "m07-adversarial.log"
& npm.cmd test -- tests/m07-adversarial.test.ts tests/m05-operator-server.test.ts 2>&1 | Tee-Object -FilePath $AdversarialLog
Require-Exit "M07_ADVERSARIAL_TESTS"
Write-Host "OPERATOR13_STILL_INACTIVE=PASS"

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
Write-Host "[4] Disposable live S0/S1 task-runner proof"
$LiveResultPath = Join-Path $EvidenceRoot "live-m07-result.json"
& node.exe (Join-Path $Root "scripts\live-m07-qualification.mjs") $RuntimeRoot $LiveResultPath
Require-Exit "LIVE_M07_TASK_RUNNER_PROOF"
$Live = Get-Content -Raw -LiteralPath $LiveResultPath | ConvertFrom-Json
if (@($Live.productionTasks).Count -ne 4) { throw "M07_PRODUCTION_TASK_COUNT_FAILED" }
if (-not $Live.s0NetworkDenied -or -not $Live.modifiedCodeExecuted) { throw "M07_S0_PROOF_FAILED" }
if ($Live.effectClassification -ne "ALLOWED_ARTIFACT") { throw "M07_EFFECT_CLASSIFICATION_FAILED" }
if (-not $Live.s1FixtureOnly) { throw "M07_S1_PROOF_FAILED" }
if (-not $Live.s1NamespaceIsolated) { throw "M07_S1_NAMESPACE_ISOLATION_FAILED" }
if (-not $Live.secretOutputDenied) { throw "M07_SECRET_OUTPUT_DENIAL_FAILED" }
if (-not $Live.canonicalUnchanged -or -not $Live.rollbackClean) { throw "M07_ISOLATION_CLEANUP_FAILED" }
Write-Host "M07_S0_PRODUCTION_TASKS=PASS"
Write-Host "M07_S1_FIXTURE_ONLY=PASS"
Write-Host "M07_S1_NAMESPACE_ISOLATION=PASS"
Write-Host "M07_SECRET_OUTPUT_DENIAL=PASS"
Write-Host "M07_EFFECT_CLASSIFICATION=PASS"

$ContainerResidue = @(Get-M07ContainerResidue)
$NetworkResidue = @(Get-M07NetworkResidue)
if ($ContainerResidue.Count -ne 0 -or $NetworkResidue.Count -ne 0) {
    throw "M07_DOCKER_RESIDUE"
}
Write-Host "DOCKER_RESIDUE=0"
Remove-Item -LiteralPath $RuntimeRoot -Recurse -Force
$RuntimeResidue = if (Test-Path -LiteralPath $RuntimeRoot) { 1 } else { 0 }
if ($RuntimeResidue -ne 0) { throw "RUNTIME_RESIDUE:$RuntimeResidue" }
Write-Host "RUNTIME_RESIDUE=0"
Write-Host "[5] Post-state reconciliation"
$SecretPatterns = @(
    '(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{20,}',
    '(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}',
    '(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}',
    'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY'
)
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
if (Test-Port $Port) { throw "M07_PORT_8772_POSTSTATE_FAILED" }
Write-Host "PORT_8772_FREE=PASS"
if ((git status --porcelain).Length -ne 0) { throw "POST_LIVE_WORKTREE_DRIFT" }
if ((git rev-parse HEAD).Trim() -ne $Head) { throw "POST_LIVE_HEAD_DRIFT" }
$AfterPath = Join-Path $EvidenceRoot "source-manifest-post-live.txt"
$ManifestDigestAfter = Write-DeterministicSourceManifest $AfterPath
if ($ManifestDigestAfter -ne $ManifestDigest) { throw "SOURCE_MANIFEST_DRIFT" }
Write-Host "SOURCE_MANIFEST_POST_LIVE=PASS"
Write-Host "UNAUTHORIZED_MUTATIONS=0"

$Result = [ordered]@{
    mission = "HAIOS_DESKTOP_CONTROL_PLANE_R1_M07_BOUNDED_TASK_RUNNER"
    run_id = $RunId
    head = $Head
    branch = $Branch
    parent_m06_head = $ParentHead
    source_manifest_digest = $ManifestDigest
    source_manifest_post_live_digest = $ManifestDigestAfter
    registry_sha256 = $RegistrySha
    effect_policy_sha256 = $EffectsSha
    docker_image = $Image
    docker_image_id = $ImageInspect.Id
    docker_client = $DockerClient
    docker_server = $DockerServer
    adversarial_tests = "PASS"
    full_tests = "PASS"
    full_test_passing_count = $FullTestPassingCount
    typecheck = "PASS"
    build = "PASS"
    live_s0_production_tasks = "PASS"
    live_s1_fixture_only = "PASS"
    live_s1_namespace_isolation = "PASS"
    live_secret_output_denial = "PASS"
    live_effect_classification = "PASS"
    canonical_unchanged = $true
    docker_container_residue = 0
    docker_network_residue = 0
    runtime_residue = 0
    unauthorized_mutations = 0
    secrets_persisted = $false
    tunnel_integrity = @($TunnelEvidence)
    tunnel_modified = $TunnelModified
    operator13_mode = "READ_ONLY_EMERGENCY"
    operator_run_task_public_active = $false
    s2_enabled = $false
    destructive_capability = "LOCKED"
    internal_task_runner_qualified = $true
    independent_verification = "PENDING"
    terminal = "HAIOS_DESKTOP_CONTROL_PLANE_R1_M07_READY_FOR_INDEPENDENT_VERIFICATION"
}
$ResultPath = Join-Path $EvidenceRoot "m07-qualification-result.json"
$Result | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 $ResultPath

$Handoff = [ordered]@{
    mission = $Result.mission
    run_id = $RunId
    head = $Head
    source_manifest_digest = $ManifestDigest
    review_mode = "READ_ONLY_INDEPENDENT"
    rerun_unchanged_tests = $false
    required_checks = @(        "HEAD_MATCH","MANIFEST_MATCH","AUTHORITY_SOURCE_BOUND","M06_PARENT_ANCESTRY",
        "OPERATOR13_STILL_INACTIVE","TASK_REGISTRY_HASH_BOUND","EFFECT_POLICY_HASH_BOUND",
        "NO_HOST_MUTABLE_CODE_EXECUTION","S0_NETWORK_NONE","S1_FIXTURE_ONLY",
        "NO_DOCKER_SOCKET_OR_HOST_NETWORK","PINNED_IMAGE_IDENTITY","ENTRYPOINT_SHELL_BYPASS",
        "TRANSACTION_WORKTREE_ONLY","CANONICAL_UNCHANGED","TASK_EFFECT_CLASSIFICATION",
        "OWNED_RESOURCE_CLEANUP","S2_DISABLED","TUNNEL_INTEGRITY","SECRETS_PERSISTED_FALSE",
        "SECRET_OUTPUT_FAIL_CLOSED"
    )
    allowed_verdicts = @("PASS","BLOCKED")
}
$Handoff | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $EvidenceRoot "independent-review-handoff.json")
Write-Host "RESULT_PATH=$ResultPath"
Write-Host "HAIOS_DESKTOP_CONTROL_PLANE_R1_M07_READY_FOR_INDEPENDENT_VERIFICATION" -ForegroundColor Green