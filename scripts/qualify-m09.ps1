$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
if ($PSVersionTable.PSVersion.Major -lt 7) { throw "POWERSHELL_7_REQUIRED" }
Set-Location (Split-Path -Parent $PSScriptRoot)
$Root = (Get-Location).Path
$RunId = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ", [Globalization.CultureInfo]::InvariantCulture)
$EvidenceRoot = Join-Path $Root "evidence\m09\$RunId"
$RuntimeRoot = Join-Path $Root "runtime\m09-qual-$RunId"
$DirectPort = 8773
$ProxyPort = 18773
$ParentHead = "2228ffc856f7f3170913b5f61fae0234133f4712"
$M08CertPath = "C:\Workspace\haios-desktop-control-m08\evidence\m08\20260828T121004Z\m08-final-certification.json"
$M08CertShaExpected = "11306fafff964ba1518cd2d395cdee4bae489731b109d1a6b6ec62ea1c3c4aee"
$M08Terminal = "HAIOS_DESKTOP_CONTROL_PLANE_R1_M08_CONTROLLED_OPERATOR_WIRING_QUALIFIED"
$RegistryShaExpected = "e94aaa6e60534316736a958c80bd33db691b2494b1518391a15d9f90f1e7e72c"
$EffectsShaExpected = "00dfb27757d629e09bf2f91c4247004ecd1162bdd7e14faee88c1a777b2e5335"
$SandboxImage = "haios-operator-sandbox-node@sha256:4c1909633b4c7c6e8dfce3e7994bacaf81ac30808a055d4ba790e9b7c366dcfe"
$SandboxImageIdExpected = "sha256:4c1909633b4c7c6e8dfce3e7994bacaf81ac30808a055d4ba790e9b7c366dcfe"
$TunnelImage = "ghcr.io/openai/tunnel-client:v0.0.11"
$LongLivedContainers = @("haios-tunnel-client", "haios-operator-dedicated-tunnel-client", "haios-operator-mcp")
New-Item -ItemType Directory -Force $EvidenceRoot | Out-Null
function Require-Exit([string]$Name) { if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit $LASTEXITCODE" } }
function Get-Sha256([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }
function Test-Port([int]$PortNumber) { [bool](Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue) }
function Get-ListenerIdentity([int]$PortNumber) {
  @((Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue |
    Sort-Object OwningProcess | ForEach-Object { "$($_.LocalAddress)|$($_.LocalPort)|$($_.OwningProcess)" }))
}
function Get-ContainerIntegrityDigest([string]$Name) {
  $Raw = & docker.exe inspect $Name 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $Raw) { throw "CONTAINER_UNAVAILABLE:$Name" }
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
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}
function Get-LabeledContainerResidue([string]$Label) {
  $Ids = @(& docker.exe ps -aq --filter "label=$Label" 2>$null); Require-Exit "DOCKER_CONTAINER_RESIDUE_QUERY"
  @($Ids | Where-Object { $_ -and $_.Trim() })
}
function Get-LabeledNetworkResidue([string]$Label) {
  $Ids = @(& docker.exe network ls -q --filter "label=$Label" 2>$null); Require-Exit "DOCKER_NETWORK_RESIDUE_QUERY"
  @($Ids | Where-Object { $_ -and $_.Trim() })
}
function Get-DeterministicSourceManifestLines {
  $Paths = [string[]]@(git ls-files); [Array]::Sort($Paths, [StringComparer]::Ordinal)
  foreach ($Relative in $Paths) {
    "$(Get-Sha256 (Join-Path $Root $Relative))  $($Relative.Replace('\','/'))"
  }
}
function Write-DeterministicSourceManifest([string]$Path) {
  $Text = (@(Get-DeterministicSourceManifestLines) -join "`n") + "`n"
  [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
  Get-Sha256 $Path
}
function Write-JsonNoBom([string]$Path, $Object) {
  [IO.File]::WriteAllText($Path, (($Object | ConvertTo-Json -Depth 12) + "`n"), [Text.UTF8Encoding]::new($false))
}
function Get-LongLivedOperatorHealth {
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:8769/healthz" -Method Get -TimeoutSec 4
  } catch {
    throw "M09_LONG_LIVED_OPERATOR_HEALTH_UNAVAILABLE"
  }
}

if ((git status --porcelain).Length -ne 0) { throw "WORKTREE_NOT_CLEAN" }
$Head = (git rev-parse HEAD).Trim(); $Branch = (git branch --show-current).Trim()
& git merge-base --is-ancestor $ParentHead $Head; Require-Exit "M08_PARENT_ANCESTRY"
if (-not (Test-Path -LiteralPath $M08CertPath)) { throw "M08_FINAL_CERTIFICATION_MISSING" }
$M08CertSha = Get-Sha256 $M08CertPath
if ($M08CertSha -ne $M08CertShaExpected) { throw "M08_FINAL_CERTIFICATION_HASH_DRIFT" }
$M08Cert = Get-Content -Raw -LiteralPath $M08CertPath | ConvertFrom-Json
if ($M08Cert.terminal -ne $M08Terminal -or $M08Cert.head -ne $ParentHead) {
  throw "M08_FINAL_CERTIFICATION_IDENTITY_DRIFT"
}
Write-Host "M08_FINAL_CERTIFICATION_BOUND=PASS"

$RegistrySha = Get-Sha256 (Join-Path $Root "task-registry.m07.json")
$EffectsSha = Get-Sha256 (Join-Path $Root "task-effects.m07.json")
if ($RegistrySha -ne $RegistryShaExpected) { throw "M09_REGISTRY_IDENTITY_DRIFT" }
if ($EffectsSha -ne $EffectsShaExpected) { throw "M09_EFFECT_POLICY_IDENTITY_DRIFT" }
$SandboxInspect = (& docker.exe image inspect $SandboxImage | ConvertFrom-Json)[0]; Require-Exit "M09_SANDBOX_IMAGE_INSPECT"
if ($SandboxInspect.Id -ne $SandboxImageIdExpected) { throw "M09_SANDBOX_IMAGE_ID_DRIFT" }
$TunnelInspect = (& docker.exe image inspect $TunnelImage | ConvertFrom-Json)[0]; Require-Exit "M09_TUNNEL_IMAGE_INSPECT"
if ($TunnelInspect.Config.Image -and $TunnelInspect.Config.Image -ne $TunnelImage) { throw "M09_TUNNEL_IMAGE_IDENTITY_DRIFT" }

$ContainerPre = @{}
foreach ($Name in $LongLivedContainers) { $ContainerPre[$Name] = Get-ContainerIntegrityDigest $Name }
$ContainerPreEvidence = @($LongLivedContainers | ForEach-Object { [ordered]@{ name=$_; sha256=$ContainerPre[$_] } })
$Listener8768Pre = @(Get-ListenerIdentity 8768)
$Listener8769Pre = @(Get-ListenerIdentity 8769)
if ($Listener8768Pre.Count -eq 0) { throw "SECURE_MCP_8768_REGRESSION" }
if ($Listener8769Pre.Count -eq 0) { throw "OPERATOR_MCP_8769_REGRESSION" }
if (Test-Port $DirectPort) { throw "M09_PORT_8773_NOT_FREE" }
if (Test-Port $ProxyPort) { throw "M09_PROXY_PORT_18773_NOT_FREE" }
if ((Get-LabeledContainerResidue "haios.m09.owner=host-parity").Count -ne 0) { throw "M09_PREEXISTING_CONTAINER_RESIDUE" }
if ((Get-LabeledContainerResidue "haios.m07.owner=m07").Count -ne 0) { throw "M09_PREEXISTING_M07_CONTAINER_RESIDUE" }
if ((Get-LabeledNetworkResidue "haios.m07.owner=m07").Count -ne 0) { throw "M09_PREEXISTING_M07_NETWORK_RESIDUE" }

$ManifestPrePath = Join-Path $EvidenceRoot "source-manifest-precondition.txt"
$ManifestPreDigest = Write-DeterministicSourceManifest $ManifestPrePath
$Health = Get-LongLivedOperatorHealth
$ObservedMode = [string]$Health.mode
Write-Host "M09_LONG_LIVED_OPERATOR_MODE=$ObservedMode"
if ($ObservedMode -ne "READ_ONLY_EMERGENCY") {
  $Blocker = [ordered]@{
    mission="HAIOS_DESKTOP_CONTROL_PLANE_R1_M09_HOST_RUNTIME_PARITY"
    run_id=$RunId; head=$Head; branch=$Branch
    blocker="M09_PREEXISTING_LONG_LIVED_OPERATOR_NOT_EMERGENCY"
    terminal="HAIOS_DESKTOP_CONTROL_PLANE_R1_M09_BLOCKED_PREEXISTING_LONG_LIVED_OPERATOR_STATE"
    observed_long_lived_operator_mode=$ObservedMode
    m08_final_certification_sha256=$M08CertSha
    source_manifest_digest=$ManifestPreDigest
    listener_8768=@($Listener8768Pre); listener_8769=@($Listener8769Pre)
    long_lived_container_integrity=@($ContainerPreEvidence)
    full_regression_started=$false; live_helper_started=$false; independent_review_started=$false
    direct_port_8773_free=$true; proxy_port_18773_free=$true
    disposable_active_started=$false; production_mutation_performed=$false
    production_restart_performed=$false; tunnel_cutover_performed=$false
    s2_enabled=$false; destructive_capability="LOCKED"
  }
  $BlockerPath = Join-Path $EvidenceRoot "m09-precondition-blocker.json"
  Write-JsonNoBom $BlockerPath $Blocker
  Write-Host "BLOCKER_EVIDENCE=$BlockerPath"
  throw "M09_PREEXISTING_LONG_LIVED_OPERATOR_NOT_EMERGENCY"
}
Write-Host "[1] M09 focused + adversarial qualification"
$FocusedLog = Join-Path $EvidenceRoot "m09-focused.log"
$FocusedTests = @(
  "tests/m09-adversarial.test.ts",
  "tests/m09-host-runtime-config.test.ts",
  "tests/m09-host-runtime.test.ts",
  "tests/m09-host-launcher.test.ts",
  "tests/m09-live-helper.test.ts",
  "tests/m09-tunnel-parity.test.ts",
  "tests/m08-runtime-provenance.test.ts",
  "tests/m08-adversarial.test.ts",
  "tests/m08-operator-server.test.ts",
  "tests/m07-adversarial.test.ts",
  "tests/m06-adversarial.test.ts"
)
& npm.cmd test -- @FocusedTests 2>&1 | Tee-Object -FilePath $FocusedLog
Require-Exit "M09_FOCUSED_TESTS"
& npm.cmd run typecheck; Require-Exit "TYPECHECK"
& npm.cmd run build; Require-Exit "BUILD"
Write-Host "M09_FOCUSED_TESTS=PASS"

Write-Host "[2] One final full regression on frozen committed bytes"
$FullLog = Join-Path $EvidenceRoot "full-tests.log"
& npm.cmd test 2>&1 | Tee-Object -FilePath $FullLog; Require-Exit "FULL_TESTS"
$FullText = ([IO.File]::ReadAllText($FullLog) -replace "`e\[[0-9;?]*[ -/]*[@-~]", "")
$FullMatch = [regex]::Match($FullText, 'Tests\s+(\d+)\s+passed')
if (-not $FullMatch.Success) { throw "FULL_TEST_PASS_COUNT_NOT_FOUND" }
$FullTestPassingCount = [int]$FullMatch.Groups[1].Value
Write-Host "FULL_TEST_PASSING_COUNT=$FullTestPassingCount"
if ((git status --porcelain).Length -ne 0) { throw "POST_TEST_WORKTREE_DRIFT" }
if ((git rev-parse HEAD).Trim() -ne $Head) { throw "POST_TEST_HEAD_DRIFT" }

Write-Host "[3] Freeze deterministic source identity"
$ManifestPath = Join-Path $EvidenceRoot "source-manifest.txt"
$ManifestDigest = Write-DeterministicSourceManifest $ManifestPath
Write-Host "SOURCE_MANIFEST_DIGEST=$ManifestDigest"

Write-Host "[4] Disposable M09 host ACTIVE + dev-proxy proof"
New-Item -ItemType Directory -Force $RuntimeRoot | Out-Null
$LiveResultPath = Join-Path $EvidenceRoot "live-m09-result.json"
& node.exe (Join-Path $Root "scripts\live-m09-host-parity.mjs") $RuntimeRoot $LiveResultPath $DirectPort
Require-Exit "LIVE_M09_HOST_PARITY"
$Live = Get-Content -Raw -LiteralPath $LiveResultPath | ConvertFrom-Json
$LiveRequired = @(
  "exactToolSurface","activeStatusPassed","canonicalUnchangedBeforePromotion","taskPassed",
  "promotionPassed","rollbackPassed","staleCasDenied","stalePromotionNoMutation",
  "worktreeResidueZero","apiKeyFileRemoved","tunnelExactToolSurface","tunnelStatusPassed",
  "tunnelCapabilitiesPassed","tunnelParityPassed","tunnelContainerRemoved","tunnelLogsSecretFree"
)
foreach ($Property in $LiveRequired) {
  if (-not $Live.$Property) { throw "LIVE_M09_GATE_FAILED:$Property" }
}
if ([int]$Live.directPort -ne $DirectPort -or [int]$Live.tunnelProxyPort -ne $ProxyPort) {
  throw "LIVE_M09_PORT_IDENTITY_DRIFT"
}
Write-Host "LIVE_M09_HOST_AND_TUNNEL_PARITY=PASS"
if ((Get-LabeledContainerResidue "haios.m09.owner=host-parity").Count -ne 0) { throw "M09_DOCKER_CONTAINER_RESIDUE" }
if ((Get-LabeledContainerResidue "haios.m07.owner=m07").Count -ne 0) { throw "M09_M07_CONTAINER_RESIDUE" }
if ((Get-LabeledNetworkResidue "haios.m07.owner=m07").Count -ne 0) { throw "M09_M07_NETWORK_RESIDUE" }
Remove-Item -LiteralPath $RuntimeRoot -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $RuntimeRoot) { throw "M09_RUNTIME_RESIDUE" }
if (Test-Port $DirectPort) { throw "M09_PORT_8773_POSTSTATE_FAILED" }
if (Test-Port $ProxyPort) { throw "M09_PROXY_PORT_18773_POSTSTATE_FAILED" }

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

$ContainerEvidence = @(); $ContainerModified = $false
foreach ($Name in $LongLivedContainers) {
  $Post = Get-ContainerIntegrityDigest $Name
  $Match = $ContainerPre[$Name] -eq $Post
  if (-not $Match) { $ContainerModified = $true }
  $ContainerEvidence += [ordered]@{ name=$Name; pre_sha256=$ContainerPre[$Name]; post_sha256=$Post; match=$Match }
}
if ($ContainerModified) { throw "LONG_LIVED_CONTAINER_INTEGRITY_DRIFT" }
$Listener8768Post = @(Get-ListenerIdentity 8768)
$Listener8769Post = @(Get-ListenerIdentity 8769)
if (($Listener8768Pre -join ',') -ne ($Listener8768Post -join ',')) { throw "SECURE_MCP_8768_IDENTITY_DRIFT" }
if (($Listener8769Pre -join ',') -ne ($Listener8769Post -join ',')) { throw "OPERATOR_MCP_8769_IDENTITY_DRIFT" }
$HealthPost = Get-LongLivedOperatorHealth
if ([string]$HealthPost.mode -ne "READ_ONLY_EMERGENCY") { throw "M09_LONG_LIVED_OPERATOR_MODE_DRIFT" }
if ((git status --porcelain).Length -ne 0) { throw "POST_LIVE_WORKTREE_DRIFT" }
if ((git rev-parse HEAD).Trim() -ne $Head) { throw "POST_LIVE_HEAD_DRIFT" }
$ManifestPostPath = Join-Path $EvidenceRoot "source-manifest-post-live.txt"
$ManifestPostDigest = Write-DeterministicSourceManifest $ManifestPostPath
if ($ManifestPostDigest -ne $ManifestDigest) { throw "SOURCE_MANIFEST_DRIFT" }
Write-Host "LONG_LIVED_RUNTIME_UNCHANGED=PASS"
Write-Host "SECRETS_PERSISTED=FALSE"
Write-Host "ZERO_RESIDUE=PASS"

$Result = [ordered]@{
  mission="HAIOS_DESKTOP_CONTROL_PLANE_R1_M09_HOST_RUNTIME_PARITY"
  run_id=$RunId; head=$Head; branch=$Branch
  parent_m08_head=$ParentHead; m08_final_certification_sha256=$M08CertSha
  source_manifest_digest=$ManifestDigest; source_manifest_post_live_digest=$ManifestPostDigest
  registry_sha256=$RegistrySha; effect_policy_sha256=$EffectsSha
  focused_tests="PASS"; full_tests="PASS"; full_test_passing_count=$FullTestPassingCount
  typecheck="PASS"; build="PASS"; direct_host_parity=$true; tunnel_dev_proxy_parity=$true
  live_exact_13_tools=$true; live_task=$true; live_promotion=$true; live_rollback=$true
  live_stale_cas_denial=$true; canonical_unchanged_before_promotion=$true
  worktree_residue=0; docker_container_residue=0; docker_network_residue=0; runtime_residue=0
  secrets_persisted=$false; long_lived_containers=@($ContainerEvidence); long_lived_operator_mode="READ_ONLY_EMERGENCY"
  production_operator_runtime_changed=$false; tunnel_cutover_performed=$false; production_dogfood_activated=$false
  s2_enabled=$false; destructive_capability="LOCKED"; independent_verification="PENDING"
  terminal="HAIOS_DESKTOP_CONTROL_PLANE_R1_M09_READY_FOR_INDEPENDENT_VERIFICATION"
}
$ResultPath = Join-Path $EvidenceRoot "m09-qualification-result.json"
Write-JsonNoBom $ResultPath $Result
$Handoff = [ordered]@{
  mission=$Result.mission; run_id=$RunId; head=$Head; source_manifest_digest=$ManifestDigest
  review_mode="READ_ONLY_INDEPENDENT"; rerun_unchanged_tests=$false
  required_checks=@(
    "HEAD_MATCH","MANIFEST_MATCH","M08_CERTIFICATION_BOUND","HOST_CONFIG_SECRET_BOUNDARY",
    "EXACT_13_TOOL_SURFACE","M08_RUNTIME_PROVENANCE","LOOPBACK_ONLY","NO_CALLER_RUNTIME_OVERRIDE",
    "NO_GENERIC_EXEC_AUTHORITY","NO_REMOTE_GIT_AUTHORITY","NO_REAL_TUNNEL_AUTHORITY",
    "FILE_BACKED_TUNNEL_AUTH","DIRECT_ACTIVE_E2E","CAS_PROMOTION","ROLLBACK_CLEANUP",
    "STALE_CAS_FAIL_CLOSED","LONG_LIVED_RUNTIME_UNCHANGED","ZERO_RESIDUE",
    "SECRETS_PERSISTED_FALSE","S2_DISABLED","DESTRUCTIVE_LOCKED","DOGFOOD_NOT_ACTIVATED"
  )
  allowed_verdicts=@("PASS","BLOCKED")
}
$HandoffPath = Join-Path $EvidenceRoot "independent-review-handoff.json"
Write-JsonNoBom $HandoffPath $Handoff
Write-Host "RESULT_PATH=$ResultPath"
Write-Host "HANDOFF_PATH=$HandoffPath"
Write-Host "HAIOS_DESKTOP_CONTROL_PLANE_R1_M09_READY_FOR_INDEPENDENT_VERIFICATION" -ForegroundColor Green