$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
if ($PSVersionTable.PSVersion.Major -lt 7) { throw "POWERSHELL_7_REQUIRED" }
Set-Location (Split-Path -Parent $PSScriptRoot)
$Root = (Get-Location).Path
$RunId = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ", [Globalization.CultureInfo]::InvariantCulture)
$EvidenceRoot = Join-Path $Root "evidence\m08\$RunId"
$RuntimeRoot = Join-Path $Root "runtime\m08-qual-$RunId"
$Port = 8772
$ParentHead = "9a14ad42e31dbf43306d90b1f9ec98ce3c1c38e0"
$M07CertPath = "C:\Workspace\haios-desktop-control-m07\evidence\m07\20260828T102102Z\m07-final-certification.json"
$M07CertShaExpected = "a6b58a86a4d60b5ee71dbab4672ad89c16ab5b3f30392d04eec8c03253e12533"
$M07Terminal = "HAIOS_DESKTOP_CONTROL_PLANE_R1_M07_BOUNDED_TASK_RUNNER_QUALIFIED"
$Image = "haios-operator-sandbox-node@sha256:4c1909633b4c7c6e8dfce3e7994bacaf81ac30808a055d4ba790e9b7c366dcfe"
$QualifiedRuntimeProfile = "M08_M06_M07_QUALIFIED_RUNTIME_V1"
$QualifiedRegistrySha = "e94aaa6e60534316736a958c80bd33db691b2494b1518391a15d9f90f1e7e72c"
$QualifiedEffectsSha = "00dfb27757d629e09bf2f91c4247004ecd1162bdd7e14faee88c1a777b2e5335"
New-Item -ItemType Directory -Force $EvidenceRoot,$RuntimeRoot | Out-Null
function Require-Exit([string]$Name) { if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit $LASTEXITCODE" } }
function Test-Port([int]$PortNumber) { return [bool](Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue) }
function Get-Sha256([string]$Path) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }
function Get-ListenerIdentity([int]$PortNumber) { return @((Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue | Sort-Object OwningProcess | ForEach-Object { "$($_.LocalAddress)|$($_.LocalPort)|$($_.OwningProcess)" })) }
function Get-DeterministicSourceManifestLines {
  $Paths = [string[]]@(git ls-files); [Array]::Sort($Paths, [StringComparer]::Ordinal)
  foreach ($Relative in $Paths) { "$(Get-Sha256 (Join-Path $Root $Relative))  $($Relative.Replace('\','/'))" }
}
function Write-DeterministicSourceManifest([string]$Path) {
  $Text = (@(Get-DeterministicSourceManifestLines) -join "`n") + "`n"
  [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false)); return Get-Sha256 $Path
}
$TunnelContainers = @("haios-tunnel-client", "haios-operator-dedicated-tunnel-client")
function Get-TunnelIntegrityDigest([string]$ContainerName) {
  $Raw = & docker.exe inspect $ContainerName 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $Raw) { throw "TUNNEL_CONTAINER_UNAVAILABLE:$ContainerName" }
  $Object = ($Raw | ConvertFrom-Json)[0]
  $Networks = @($Object.NetworkSettings.Networks.PSObject.Properties | Sort-Object Name | ForEach-Object { [ordered]@{ name=$_.Name; network_id=$_.Value.NetworkID; endpoint_id=$_.Value.EndpointID; ip=$_.Value.IPAddress; gateway=$_.Value.Gateway } })
  $Mounts = @($Object.Mounts | ForEach-Object { [ordered]@{ type=$_.Type; destination=$_.Destination; mode=$_.Mode; rw=$_.RW; propagation=$_.Propagation } })
  $Snapshot = [ordered]@{ id=$Object.Id; created=$Object.Created; image_id=$Object.Image; config_image=$Object.Config.Image; path=$Object.Path; args=@($Object.Args); network_mode=$Object.HostConfig.NetworkMode; restart_policy=$Object.HostConfig.RestartPolicy; mounts=$Mounts; networks=$Networks }
  $Bytes = [Text.Encoding]::UTF8.GetBytes(($Snapshot | ConvertTo-Json -Depth 8 -Compress))
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}
function Get-M07ContainerResidue { $Ids=@(& docker.exe ps -aq --filter "label=haios.m07.owner=m07" 2>$null); Require-Exit "DOCKER_CONTAINER_RESIDUE_QUERY"; return @($Ids | Where-Object { $_ -and $_.Trim() }) }
function Get-M07NetworkResidue { $Ids=@(& docker.exe network ls -q --filter "label=haios.m07.owner=m07" 2>$null); Require-Exit "DOCKER_NETWORK_RESIDUE_QUERY"; return @($Ids | Where-Object { $_ -and $_.Trim() }) }

if ((git status --porcelain).Length -ne 0) { throw "WORKTREE_NOT_CLEAN" }
$Head=(git rev-parse HEAD).Trim(); $Branch=(git branch --show-current).Trim()
& git merge-base --is-ancestor $ParentHead $Head; Require-Exit "M07_PARENT_ANCESTRY"
if (-not (Test-Path -LiteralPath $M07CertPath)) { throw "M07_FINAL_CERTIFICATION_MISSING" }
$M07CertSha=Get-Sha256 $M07CertPath; if($M07CertSha -ne $M07CertShaExpected){throw "M07_FINAL_CERTIFICATION_HASH_DRIFT"}
$M07Cert=Get-Content -Raw -LiteralPath $M07CertPath | ConvertFrom-Json
if($M07Cert.terminal -ne $M07Terminal -or $M07Cert.head -ne $ParentHead){throw "M07_FINAL_CERTIFICATION_IDENTITY_DRIFT"}
Write-Host "M07_FINAL_CERTIFICATION_BOUND=PASS"
$TunnelPre=@{}; foreach($Name in $TunnelContainers){$TunnelPre[$Name]=Get-TunnelIntegrityDigest $Name}
$Listener8768Pre=@(Get-ListenerIdentity 8768); $Listener8769Pre=@(Get-ListenerIdentity 8769)
if($Listener8768Pre.Count -eq 0){throw "SECURE_MCP_8768_REGRESSION"}; if($Listener8769Pre.Count -eq 0){throw "OPERATOR_MCP_8769_REGRESSION"}; if(Test-Port $Port){throw "M08_PORT_8772_NOT_FREE"}
if((Get-M07ContainerResidue).Count -ne 0 -or (Get-M07NetworkResidue).Count -ne 0){throw "M08_PREEXISTING_DOCKER_RESIDUE"}
$ImageInspect=(& docker.exe image inspect $Image | ConvertFrom-Json)[0]; Require-Exit "M08_PINNED_IMAGE_INSPECT"
if($ImageInspect.Id -ne "sha256:4c1909633b4c7c6e8dfce3e7994bacaf81ac30808a055d4ba790e9b7c366dcfe"){throw "M08_IMAGE_ID_DRIFT"}
$RegistrySha=Get-Sha256 (Join-Path $Root "task-registry.m07.json"); $EffectsSha=Get-Sha256 (Join-Path $Root "task-effects.m07.json")
if($RegistrySha -ne $QualifiedRegistrySha){throw "M08_QUALIFIED_REGISTRY_IDENTITY_DRIFT"}
if($EffectsSha -ne $QualifiedEffectsSha){throw "M08_QUALIFIED_EFFECT_POLICY_IDENTITY_DRIFT"}
Write-Host "M08_QUALIFIED_RUNTIME_PROVENANCE=PASS"
Write-Host "M08_RUN_ID=$RunId"; Write-Host "HEAD=$Head"; Write-Host "BRANCH=$Branch"; Write-Host "REGISTRY_SHA256=$RegistrySha"; Write-Host "EFFECT_POLICY_SHA256=$EffectsSha"

Write-Host "[1] M08 focused + adversarial qualification"
$AdversarialLog=Join-Path $EvidenceRoot "m08-adversarial.log"
& npm.cmd test -- tests/m08-adversarial.test.ts tests/m08-runtime-provenance.test.ts tests/m08-live-helper.test.ts tests/m08-operator-runtime.test.ts tests/m08-operator-server.test.ts tests/m05-operator-server.test.ts tests/m06-adversarial.test.ts tests/m07-adversarial.test.ts 2>&1 | Tee-Object -FilePath $AdversarialLog
Require-Exit "M08_ADVERSARIAL_TESTS"; Write-Host "M08_ADVERSARIAL_TESTS=PASS"

Write-Host "[2] One final full regression on frozen committed bytes"
$FullTestLog=Join-Path $EvidenceRoot "full-tests.log"
& npm.cmd test 2>&1 | Tee-Object -FilePath $FullTestLog; Require-Exit "FULL_TESTS"
$FullText=([IO.File]::ReadAllText($FullTestLog) -replace "`e\[[0-9;?]*[ -/]*[@-~]", "")
$FullMatch=[regex]::Match($FullText,'Tests\s+(\d+)\s+passed'); if(-not $FullMatch.Success){throw "FULL_TEST_PASS_COUNT_NOT_FOUND"}
$FullTestPassingCount=[int]$FullMatch.Groups[1].Value; Write-Host "FULL_TEST_PASSING_COUNT=$FullTestPassingCount"
& npm.cmd run typecheck; Require-Exit "TYPECHECK"; & npm.cmd run build; Require-Exit "BUILD"

Write-Host "[3] Freeze deterministic source identity"
$ManifestPath=Join-Path $EvidenceRoot "source-manifest.txt"; $ManifestDigest=Write-DeterministicSourceManifest $ManifestPath
Write-Host "SOURCE_MANIFEST_DIGEST=$ManifestDigest"
if((git status --porcelain).Length -ne 0){throw "POST_TEST_WORKTREE_DRIFT"}; if((git rev-parse HEAD).Trim() -ne $Head){throw "POST_TEST_HEAD_DRIFT"}

Write-Host "[4] Disposable ACTIVE operator13 MCP proof"
$LiveResultPath=Join-Path $EvidenceRoot "live-m08-result.json"
& node.exe (Join-Path $Root "scripts\live-m08-qualification.mjs") $RuntimeRoot $LiveResultPath; Require-Exit "LIVE_M08_ACTIVE_PROOF"
$Live=Get-Content -Raw -LiteralPath $LiveResultPath | ConvertFrom-Json
foreach($Property in @("exactToolSurface","activeStatusPassed","canonicalUnchangedBeforePromotion","taskPassed","promotionPassed","rollbackPassed","staleCasDenied","stalePromotionNoMutation","worktreeResidueZero")){if(-not $Live.$Property){throw "LIVE_M08_GATE_FAILED:$Property"}}
Write-Host "LIVE_M08_EXACT_13_TOOLS=PASS"; Write-Host "LIVE_M08_ACTIVE_STATUS=PASS"; Write-Host "LIVE_M08_TASK=PASS"; Write-Host "LIVE_M08_PROMOTION=PASS"; Write-Host "LIVE_M08_ROLLBACK=PASS"; Write-Host "LIVE_M08_STALE_CAS_DENIAL=PASS"; Write-Host "WORKTREE_RESIDUE=0"
$ContainerResidue=@(Get-M07ContainerResidue); $NetworkResidue=@(Get-M07NetworkResidue)
if($ContainerResidue.Count -ne 0 -or $NetworkResidue.Count -ne 0){throw "M08_DOCKER_RESIDUE"}; Write-Host "DOCKER_RESIDUE=0"
Remove-Item -LiteralPath $RuntimeRoot -Recurse -Force
if(Test-Path -LiteralPath $RuntimeRoot){throw "M08_RUNTIME_RESIDUE"}; Write-Host "RUNTIME_RESIDUE=0"

Write-Host "[5] Post-state reconciliation"
$SecretPatterns=@('(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{20,}','(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}','(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}','BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY')
$SecretLeak=$false; foreach($File in (Get-ChildItem $EvidenceRoot -File -ErrorAction SilentlyContinue)){ $Text=[IO.File]::ReadAllText($File.FullName); foreach($Pattern in $SecretPatterns){if($Text -match $Pattern){$SecretLeak=$true}} }
if($SecretLeak){throw "SECRETS_PERSISTED"}; Write-Host "SECRETS_PERSISTED=FALSE"
$TunnelEvidence=@(); $TunnelModified=$false
foreach($Name in $TunnelContainers){$Post=Get-TunnelIntegrityDigest $Name; $Match=$TunnelPre[$Name] -eq $Post; if(-not $Match){$TunnelModified=$true}; $TunnelEvidence += [ordered]@{name=$Name;pre_sha256=$TunnelPre[$Name];post_sha256=$Post;match=$Match}}
if($TunnelModified){throw "TUNNEL_INTEGRITY_DRIFT"}; Write-Host "TUNNEL_INTEGRITY=PASS"
$Listener8768Post=@(Get-ListenerIdentity 8768); $Listener8769Post=@(Get-ListenerIdentity 8769)
if(($Listener8768Pre -join ',') -ne ($Listener8768Post -join ',') -or ($Listener8769Pre -join ',') -ne ($Listener8769Post -join ',')){throw "LONG_LIVED_OPERATOR_RUNTIME_IDENTITY_DRIFT"}
Write-Host "ACTIVE_PRODUCTION_RUNTIME_UNCHANGED=PASS"
if(Test-Port $Port){throw "M08_PORT_8772_POSTSTATE_FAILED"}; Write-Host "PORT_8772_FREE=PASS"
if((git status --porcelain).Length -ne 0){throw "POST_LIVE_WORKTREE_DRIFT"}; if((git rev-parse HEAD).Trim() -ne $Head){throw "POST_LIVE_HEAD_DRIFT"}
$AfterPath=Join-Path $EvidenceRoot "source-manifest-post-live.txt"; $ManifestDigestAfter=Write-DeterministicSourceManifest $AfterPath
if($ManifestDigestAfter -ne $ManifestDigest){throw "SOURCE_MANIFEST_DRIFT"}; Write-Host "SOURCE_MANIFEST_POST_LIVE=PASS"; Write-Host "UNAUTHORIZED_MUTATIONS=0"

$Result=[ordered]@{
  mission="HAIOS_DESKTOP_CONTROL_PLANE_R1_M08_CONTROLLED_OPERATOR_WIRING"; run_id=$RunId; head=$Head; branch=$Branch
  parent_m07_head=$ParentHead; m07_final_certification_sha256=$M07CertSha; m07_source_manifest_digest=$M07Cert.source_manifest_digest
  source_manifest_digest=$ManifestDigest; source_manifest_post_live_digest=$ManifestDigestAfter; registry_sha256=$RegistrySha; effect_policy_sha256=$EffectsSha
  docker_image=$Image; docker_image_id=$ImageInspect.Id; adversarial_tests="PASS"; full_tests="PASS"; full_test_passing_count=$FullTestPassingCount; typecheck="PASS"; build="PASS"
  live_exact_13_tools=$true; live_active_status=$true; live_task=$true; live_promotion=$true; live_rollback=$true; live_stale_cas_denial=$true; canonical_unchanged_before_promotion=$true
  worktree_residue=0; docker_container_residue=0; docker_network_residue=0; runtime_residue=0; unauthorized_mutations=0; secrets_persisted=$false
  tunnel_integrity=@($TunnelEvidence); tunnel_modified=$false; long_lived_operator_mode="READ_ONLY_EMERGENCY"; disposable_active_operator_qualified=$true; qualified_runtime_provenance=$true; qualified_runtime_profile=$QualifiedRuntimeProfile; production_operator_runtime_changed=$false
  s2_enabled=$false; destructive_capability="LOCKED"; production_dogfood_activated=$false; independent_verification="PENDING"
  terminal="HAIOS_DESKTOP_CONTROL_PLANE_R1_M08_READY_FOR_INDEPENDENT_VERIFICATION"
}
$ResultPath=Join-Path $EvidenceRoot "m08-qualification-result.json"; [IO.File]::WriteAllText($ResultPath, (($Result | ConvertTo-Json -Depth 10) + "`n"), [Text.UTF8Encoding]::new($false))
$Handoff=[ordered]@{
  mission=$Result.mission; run_id=$RunId; head=$Head; source_manifest_digest=$ManifestDigest; review_mode="READ_ONLY_INDEPENDENT"; rerun_unchanged_tests=$false
  required_checks=@("HEAD_MATCH","MANIFEST_MATCH","M07_CERTIFICATION_BOUND","EXACT_13_TOOL_SURFACE","EXPLICIT_ACTIVE_RUNTIME_GATE","RUNTIME_PROVENANCE_AND_IDENTITY_BINDING","INACTIVE_MODE_UNCHANGED","LEGACY27_UNCHANGED","SERVER_BOUND_REGISTRY_DIGEST","M06_TRANSACTION_ISOLATION","M07_TASK_RUNNER_BINDING","PUBLIC_INPUT_EXACT_KEYS","NO_GENERIC_EXEC_AUTHORITY","NO_REMOTE_GIT_AUTHORITY","S2_DISABLED","DESTRUCTIVE_LOCKED","CANONICAL_UNCHANGED_BEFORE_PROMOTION","LOCAL_CHECKPOINT_ONLY","CAS_PROMOTION","ROLLBACK_CLEANUP","STALE_CAS_FAIL_CLOSED","TASK_FAILURE_FAIL_CLOSED","EFFECT_POLICY_FAIL_CLOSED","TUNNEL_INTEGRITY","LONG_LIVED_RUNTIME_UNCHANGED","ZERO_RESIDUE","SECRETS_PERSISTED_FALSE","DOGFOOD_NOT_ACTIVATED")
  allowed_verdicts=@("PASS","BLOCKED")
}
$HandoffPath=Join-Path $EvidenceRoot "independent-review-handoff.json"; [IO.File]::WriteAllText($HandoffPath, (($Handoff | ConvertTo-Json -Depth 6) + "`n"), [Text.UTF8Encoding]::new($false))
Write-Host "RESULT_PATH=$ResultPath"; Write-Host "HANDOFF_PATH=$HandoffPath"; Write-Host "HAIOS_DESKTOP_CONTROL_PLANE_R1_M08_READY_FOR_INDEPENDENT_VERIFICATION" -ForegroundColor Green
