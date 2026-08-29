$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
if ($PSVersionTable.PSVersion.Major -lt 7) { throw "POWERSHELL_7_REQUIRED" }
Set-Location (Split-Path -Parent $PSScriptRoot)
$Root = (Get-Location).Path
$RunId = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ", [Globalization.CultureInfo]::InvariantCulture)
$EvidenceRoot = Join-Path $Root "evidence\m10\$RunId"
$RuntimeRoot = Join-Path $Root "runtime\m10-qual-$RunId"
$PreflightRelative = "evidence\m10\$RunId\preflight"
$ParentHead = "8496242a443ca53e99c6357023a7321cb7394e44"
$ParentCert = "C:\Workspace\haios-desktop-control-m09\evidence\m09\20260828T151328Z\m09-final-certification.json"
$ParentCertShaExpected = "7ec685bdf157f37d8d0525f7da6ec60257b189bbde5bef77731ea344ef82d946"
$ParentTerminal = "HAIOS_DESKTOP_CONTROL_PLANE_R1_M09_HOST_RUNTIME_PARITY_QUALIFIED"
$OperatorCompose = "C:\Workspace\haios-operator-mcp\docker-compose.operator.yml"
$DedicatedCompose = "C:\Workspace\haios-operator-mcp\docker-compose.operator-dedicated-tunnel.yml"
$DeploymentRoot = "C:\Workspace\haios-desktop-control-runtime"
$StateRoot = Join-Path $env:LOCALAPPDATA "HAIOS\M10"
$TaskName = "HAIOS-M10-Operator-ReadOnly"
$DirectPort = 8774
$ProxyPort = 18774
$ExactDecision = "APPROVE HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_STAGED_READ_ONLY_CUTOVER"
New-Item -ItemType Directory -Force $EvidenceRoot | Out-Null
$Containers = @("haios-operator-mcp","haios-operator-dedicated-tunnel-client","haios-tunnel-client")
$TunnelImage = "ghcr.io/openai/tunnel-client:v0.0.11"
$SandboxImage = "haios-operator-sandbox-node@sha256:4c1909633b4c7c6e8dfce3e7994bacaf81ac30808a055d4ba790e9b7c366dcfe"
$ExecutorPath = Join-Path $Root "scripts\execute-m10-readonly-cutover.ps1"
$RollbackPath = Join-Path $Root "scripts\rollback-m10-readonly-cutover.ps1"
$PreflightPath = Join-Path $Root "scripts\m10-preflight.ps1"
$LiveQualifierPath = Join-Path $Root "scripts\qualify-m10-live.ps1"
$StrictLauncherPath = Join-Path $Root "scripts\run-m10-readonly-runtime.mjs"
$StrictSupervisorPath = Join-Path $Root "scripts\run-m10-readonly-supervisor.mjs"
function Require-Exit([string]$Name) { if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit $LASTEXITCODE" } }
function Get-Sha256([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }
function Write-JsonNoBom([string]$Path, $Object) {
  [IO.File]::WriteAllText($Path, (($Object | ConvertTo-Json -Depth 16) + "`n"), [Text.UTF8Encoding]::new($false))
}
function Test-Port([int]$PortNumber) { [bool](Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue) }
function Get-ListenerIdentity([int]$PortNumber) {
  @((Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue |
    Sort-Object LocalAddress,OwningProcess | ForEach-Object { "$($_.LocalAddress)|$($_.LocalPort)|$($_.OwningProcess)" }))
}
function Get-LabeledContainerResidue([string]$Label) {
  $ids=@(& docker.exe ps -aq --filter "label=$Label" 2>$null); Require-Exit "M10_CONTAINER_RESIDUE_QUERY"
  @($ids | Where-Object { $_ -and $_.Trim() })
}
function Get-ContainerHealthStatus([string]$Name) {
  $status=(& docker.exe inspect --format '{{.State.Health.Status}}' $Name 2>$null).Trim()
  if($LASTEXITCODE -ne 0 -or -not $status){throw "M10_CONTAINER_HEALTH_UNAVAILABLE:$Name"}
  $status
}
function Test-ContainerHttpGet([string]$Name,[string]$Url) {
  & docker.exe exec $Name sh -c "wget -T 3 -qO- '$Url' >/dev/null" 2>$null
  $LASTEXITCODE -eq 0
}
function Get-TunnelFunctionalReadiness([string]$Name,[int]$HealthPort,[string]$BackendHealthUrl) {
  $state=(& docker.exe inspect --format '{{.State.Status}}' $Name 2>$null).Trim()
  if($LASTEXITCODE -ne 0 -or -not $state){throw "M10_TUNNEL_STATE_UNAVAILABLE:$Name"}
  $dockerHealth=Get-ContainerHealthStatus $Name
  $healthzPass=Test-ContainerHttpGet $Name "http://127.0.0.1:$HealthPort/healthz"
  $backendReachable=Test-ContainerHttpGet $Name $BackendHealthUrl
  $metrics=& docker.exe exec $Name sh -c "wget -T 3 -qO- http://127.0.0.1:$HealthPort/metrics" 2>$null
  $metricsOk=$LASTEXITCODE -eq 0 -and [bool]$metrics
  $pollRecent=$false; $pollAge=$null
  if($metricsOk){
    $match=[regex]::Match(($metrics -join "`n"),'commands_poll_last_successful_timestamp_seconds\{[^}]*\}\s+([0-9.eE+\-]+)')
    if($match.Success){
      $poll=[double]::Parse($match.Groups[1].Value,[Globalization.CultureInfo]::InvariantCulture)
      $pollAge=[Math]::Max(0,[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()-[int64][Math]::Floor($poll))
      $pollRecent=$pollAge -le 120
    }
  }
  [ordered]@{
    name=$Name;container_running=($state -eq 'running');docker_health_observation=$dockerHealth
    healthz_pass=$healthzPass;backend_reachable=$backendReachable
    control_plane_poll_recent=$pollRecent;control_plane_poll_age_seconds=$pollAge
    functional_ready=($state -eq 'running' -and $healthzPass -and $backendReachable -and $pollRecent)
  }
}
function Get-ContainerIntegrityDigest([string]$Name) {
  $raw=& docker.exe inspect $Name 2>$null
  if($LASTEXITCODE -ne 0 -or -not $raw){throw "M10_CONTAINER_UNAVAILABLE:$Name"}
  $o=($raw|ConvertFrom-Json)[0]
  $net=@($o.NetworkSettings.Networks.PSObject.Properties|Sort-Object Name|ForEach-Object{
    [ordered]@{name=$_.Name;network_id=$_.Value.NetworkID;endpoint_id=$_.Value.EndpointID;ip=$_.Value.IPAddress;gateway=$_.Value.Gateway}
  })
  $mount=@($o.Mounts|Sort-Object Destination,Type|ForEach-Object{
    [ordered]@{type=$_.Type;destination=$_.Destination;mode=$_.Mode;rw=$_.RW;propagation=$_.Propagation}
  })
  $snap=[ordered]@{id=$o.Id;created=$o.Created;image_id=$o.Image;config_image=$o.Config.Image;path=$o.Path;args=@($o.Args);network_mode=$o.HostConfig.NetworkMode;restart_policy=$o.HostConfig.RestartPolicy;mounts=$mount;networks=$net}
  $bytes=[Text.Encoding]::UTF8.GetBytes(($snap|ConvertTo-Json -Depth 8 -Compress))
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
function Get-ManifestLines {
  $paths=[string[]]@(git ls-files); [Array]::Sort($paths,[StringComparer]::Ordinal)
  foreach($rel in $paths){"$(Get-Sha256 (Join-Path $Root $rel))  $($rel.Replace('\','/'))"}
}
function Write-Manifest([string]$Path) {
  $text=(@(Get-ManifestLines)-join "`n")+"`n"
  [IO.File]::WriteAllText($Path,$text,[Text.UTF8Encoding]::new($false))
  Get-Sha256 $Path
}function Get-ManifestDigestAt([string]$RepoRoot) {
  $paths=[string[]]@(& git.exe -C $RepoRoot ls-files); Require-Exit "M10_DEPLOYMENT_PROOF_ENUM"
  [Array]::Sort($paths,[StringComparer]::Ordinal)
  $lines=foreach($rel in $paths){"$(Get-Sha256 (Join-Path $RepoRoot $rel))  $($rel.Replace('\','/'))"}
  $text=($lines -join "`n")+"`n"; $bytes=[Text.Encoding]::UTF8.GetBytes($text)
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
function Materialize-SealedTrackedBytesAt([string]$SourceRoot,[string]$TargetRoot) {
  $paths=[string[]]@(& git.exe -C $SourceRoot ls-files); Require-Exit "M10_DEPLOYMENT_PROOF_SOURCE_ENUM"
  [Array]::Sort($paths,[StringComparer]::Ordinal)
  foreach($rel in $paths){
    $src=Join-Path $SourceRoot $rel; $dst=Join-Path $TargetRoot $rel
    if(-not(Test-Path -LiteralPath $src -PathType Leaf)){throw "M10_DEPLOYMENT_PROOF_SOURCE_MEMBER_MISSING:$rel"}
    $parent=Split-Path -Parent $dst
    if($parent -and -not(Test-Path -LiteralPath $parent)){New-Item -ItemType Directory -Force -Path $parent|Out-Null}
    Copy-Item -LiteralPath $src -Destination $dst -Force
  }
}
if ((git status --porcelain).Length -ne 0) { throw "WORKTREE_NOT_CLEAN" }
$Head=(git rev-parse HEAD).Trim(); $Branch=(git branch --show-current).Trim()
& git merge-base --is-ancestor $ParentHead $Head; Require-Exit "M09_PARENT_ANCESTRY"
if(-not(Test-Path -LiteralPath $ParentCert)){throw "M09_FINAL_CERTIFICATION_MISSING"}
$ParentCertSha=Get-Sha256 $ParentCert
if($ParentCertSha -ne $ParentCertShaExpected){throw "M09_FINAL_CERTIFICATION_HASH_DRIFT"}
$Parent=Get-Content -Raw -LiteralPath $ParentCert|ConvertFrom-Json
if([string]$Parent.head -ne $ParentHead -or [string]$Parent.terminal -ne $ParentTerminal){throw "M09_FINAL_CERTIFICATION_IDENTITY_DRIFT"}
& git fetch origin main --quiet; Require-Exit "REMOTE_MAIN_FETCH"
$RemoteMain=(git rev-parse origin/main).Trim()
if($RemoteMain -ne $ParentHead){throw "REMOTE_MAIN_DRIFT"}
try{$health=Invoke-RestMethod -Uri "http://127.0.0.1:8769/healthz" -TimeoutSec 3}catch{throw "M10_PREEXISTING_OPERATOR_HEALTH_UNAVAILABLE"}
if([string]$health.mode -ne "READ_ONLY_EMERGENCY"){throw "M10_PREEXISTING_OPERATOR_NOT_EMERGENCY"}
$Listener8768Pre=@(Get-ListenerIdentity 8768); if($Listener8768Pre.Count -eq 0){throw "M10_LISTENER_8768_MISSING"}
$Listener8769Pre=@(Get-ListenerIdentity 8769); if($Listener8769Pre.Count -eq 0){throw "M10_LISTENER_8769_MISSING"}
if(Test-Port $DirectPort){throw "M10_PORT_8774_NOT_FREE"}
if(Test-Port $ProxyPort){throw "M10_PORT_18774_NOT_FREE"}
if(Test-Path -LiteralPath $DeploymentRoot){throw "M10_DEPLOYMENT_ROOT_COLLISION"}
if(Test-Path -LiteralPath $StateRoot){throw "M10_STATE_ROOT_COLLISION"}
if(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue){throw "M10_TASK_COLLISION"}
if((Get-LabeledContainerResidue "haios.m10.owner=readonly-parity").Count -ne 0){throw "M10_PREEXISTING_CONTAINER_RESIDUE"}
$m10Processes=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -and ($_.CommandLine -match 'run-m10-readonly-runtime\.mjs|live-m10-readonly-parity\.mjs')
})
if($m10Processes.Count -ne 0){throw "M10_PREEXISTING_PROCESS_RESIDUE"}
& docker.exe image inspect $TunnelImage *> $null; Require-Exit "M10_TUNNEL_IMAGE_UNAVAILABLE"
& docker.exe image inspect $SandboxImage *> $null; Require-Exit "M10_SANDBOX_IMAGE_UNAVAILABLE"
$ContainerPre=@{}
foreach($name in $Containers){$ContainerPre[$name]=Get-ContainerIntegrityDigest $name}
$ContainerPreEvidence=@($Containers|ForEach-Object{[ordered]@{name=$_;sha256=$ContainerPre[$_]}})
$DedicatedPreInspect=(& docker.exe inspect "haios-operator-dedicated-tunnel-client" 2>$null | ConvertFrom-Json)[0]
if(-not $DedicatedPreInspect){throw "M10_DEDICATED_CONTAINER_MISSING"}
$DedicatedControlMount=@($DedicatedPreInspect.Mounts|Where-Object{$_.Destination -eq "/run/secrets/control-plane-api-key"})[0]
if(-not $DedicatedControlMount -or -not $DedicatedControlMount.Source){throw "M10_DEDICATED_CONTROL_KEY_BINDING_MISSING"}
$DedicatedControlKeyFile=[IO.Path]::GetFullPath([string]$DedicatedControlMount.Source)
if(-not(Test-Path -LiteralPath $DedicatedControlKeyFile -PathType Leaf)){throw "M10_DEDICATED_CONTROL_KEY_BINDING_MISSING"}
$DedicatedControlKeySha=Get-Sha256 $DedicatedControlKeyFile
$SharedTunnelSha=[string]$ContainerPre["haios-tunnel-client"]
$OperatorComposeSha=Get-Sha256 $OperatorCompose
$DedicatedComposeSha=Get-Sha256 $DedicatedCompose
$ExecutorSha=Get-Sha256 $ExecutorPath
$RollbackSha=Get-Sha256 $RollbackPath
$PreflightSha=Get-Sha256 $PreflightPath
$LiveQualifierSha=Get-Sha256 $LiveQualifierPath
$StrictLauncherSha=Get-Sha256 $StrictLauncherPath
$StrictSupervisorSha=Get-Sha256 $StrictSupervisorPath
$SharedTunnelReadiness=Get-TunnelFunctionalReadiness "haios-tunnel-client" 8080 "http://haios-local-mcp:8768/healthz"
$DedicatedTunnelReadiness=Get-TunnelFunctionalReadiness "haios-operator-dedicated-tunnel-client" 8079 "http://operator-mcp:8769/healthz"
$TunnelReadiness=[ordered]@{shared=$SharedTunnelReadiness;dedicated=$DedicatedTunnelReadiness}
Write-JsonNoBom (Join-Path $EvidenceRoot "m10-tunnel-functional-readiness.json") $TunnelReadiness
if(-not [bool]$SharedTunnelReadiness.functional_ready -or -not [bool]$DedicatedTunnelReadiness.functional_ready){
  $Blocker=[ordered]@{
    mission="HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_STAGED_READ_ONLY_CUTOVER";run_id=$RunId;head=$Head;branch=$Branch
    blocker=if(-not [bool]$SharedTunnelReadiness.functional_ready){"M10_SHARED_TUNNEL_FUNCTIONAL_READINESS_FAILED"}else{"M10_DEDICATED_TUNNEL_FUNCTIONAL_READINESS_FAILED"}
    shared_tunnel=$SharedTunnelReadiness;dedicated_tunnel=$DedicatedTunnelReadiness
    listener_8768=@($Listener8768Pre);listener_8769=@($Listener8769Pre);operator_mode="READ_ONLY_EMERGENCY"
    production_mutation_performed=$false;task_created=$false;secret_created=$false;tunnel_reconfigured=$false
    terminal="HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_BLOCKED_PREEXISTING_TUNNEL_READINESS"
  }
  $BlockerPath=Join-Path $EvidenceRoot "m10-operational-readiness-blocker.json"
  Write-JsonNoBom $BlockerPath $Blocker
  if(-not [bool]$SharedTunnelReadiness.functional_ready){throw "M10_SHARED_TUNNEL_FUNCTIONAL_READINESS_FAILED"}
  throw "M10_DEDICATED_TUNNEL_FUNCTIONAL_READINESS_FAILED"
}
Write-Host "M10_PRECONDITIONS=PASS"
Write-Host "M10_PRODUCTION_MUTATION_PERFORMED=FALSE"

Write-Host "[1] Focused M10 + inherited security qualification"
$FocusedLog=Join-Path $EvidenceRoot "focused-tests.log"
$FocusedTests=@(
  "tests/m10-production-config.test.ts","tests/m10-preflight-contract.test.ts","tests/m10-readonly-parity.test.ts",
  "tests/m10-cutover-transaction.test.ts","tests/m10-adversarial.test.ts","tests/m10-supervisor.test.ts","tests/m09-host-runtime-config.test.ts",
  "tests/m09-host-runtime.test.ts","tests/m09-host-launcher.test.ts","tests/m09-live-helper.test.ts",
  "tests/m09-tunnel-parity.test.ts","tests/m09-adversarial.test.ts","tests/m08-runtime-provenance.test.ts",
  "tests/m08-adversarial.test.ts","tests/m08-operator-server.test.ts","tests/m07-adversarial.test.ts","tests/m06-adversarial.test.ts"
)
& npm.cmd test -- @FocusedTests 2>&1 | Tee-Object -FilePath $FocusedLog
Require-Exit "M10_FOCUSED_TESTS"
& npm.cmd run typecheck; Require-Exit "TYPECHECK"
& npm.cmd run build; Require-Exit "BUILD"
Write-Host "M10_FOCUSED_TESTS=PASS"

Write-Host "[2] One final full regression on frozen committed bytes"
$FullLog=Join-Path $EvidenceRoot "full-tests.log"
& npm.cmd test 2>&1 | Tee-Object -FilePath $FullLog
Require-Exit "FULL_TESTS"
$FullText=([IO.File]::ReadAllText($FullLog) -replace "`e\[[0-9;?]*[ -/]*[@-~]","")
$TestMatch=[regex]::Match($FullText,'Tests\s+(\d+)\s+passed')
$FileMatch=[regex]::Match($FullText,'Test Files\s+(\d+)\s+passed')
if(-not $TestMatch.Success -or -not $FileMatch.Success){throw "M10_FULL_TEST_COUNTS_NOT_FOUND"}
$FullTests=[int]$TestMatch.Groups[1].Value; $FullFiles=[int]$FileMatch.Groups[1].Value
if((git status --porcelain).Length -ne 0){throw "M10_POST_TEST_WORKTREE_DRIFT"}
if((git rev-parse HEAD).Trim() -ne $Head){throw "M10_POST_TEST_HEAD_DRIFT"}
Write-Host "[3] Freeze deterministic source manifest"
$ManifestPath=Join-Path $EvidenceRoot "source-manifest.txt"
$ManifestDigest=Write-Manifest $ManifestPath
Write-Host "SOURCE_MANIFEST_DIGEST=$ManifestDigest"

Write-Host "[4] Independent deployment byte reproducibility proof"
$ProofRoot=Join-Path $Root "runtime\m10-deployment-proof-$RunId"
if(Test-Path -LiteralPath $ProofRoot){throw "M10_DEPLOYMENT_PROOF_ROOT_COLLISION"}
try{
  & git.exe -C $Root worktree add --detach $ProofRoot $Head; Require-Exit "M10_DEPLOYMENT_PROOF_WORKTREE_CREATE"
  $FreshCheckoutManifest=Get-ManifestDigestAt $ProofRoot
  Materialize-SealedTrackedBytesAt $Root $ProofRoot
  & git.exe -C $ProofRoot add -u; Require-Exit "M10_DEPLOYMENT_PROOF_INDEX_REFRESH"
  & git.exe -C $ProofRoot diff --cached --quiet
  if($LASTEXITCODE -ne 0){throw "M10_DEPLOYMENT_PROOF_INDEX_DRIFT"}
  & git.exe -C $ProofRoot diff --quiet
  if($LASTEXITCODE -ne 0){throw "M10_DEPLOYMENT_PROOF_WORKTREE_DRIFT"}
  if((& git.exe -C $ProofRoot status --porcelain).Length -ne 0){throw "M10_DEPLOYMENT_PROOF_WORKTREE_DRIFT"}
  $ProofManifest=Get-ManifestDigestAt $ProofRoot
  if($ProofManifest -ne $ManifestDigest){throw "M10_DEPLOYMENT_PROOF_MANIFEST_DRIFT"}
  $Proof=[ordered]@{
    head=$Head;source_manifest_sha256=$ManifestDigest;fresh_checkout_manifest_sha256=$FreshCheckoutManifest
    fresh_checkout_matches_source=($FreshCheckoutManifest -eq $ManifestDigest)
    materialized_manifest_sha256=$ProofManifest;materialized_matches_source=$true
    index_diff=$false;worktree_diff=$false;git_clean=$true
    terminal="M10_DEPLOYMENT_BYTE_REPRODUCIBILITY_PASS"
  }
  Write-JsonNoBom (Join-Path $EvidenceRoot "m10-deployment-byte-reproducibility.json") $Proof
  Write-Host "M10_DEPLOYMENT_BYTE_REPRODUCIBILITY_PASS"
}finally{
  if(Test-Path -LiteralPath $ProofRoot){
    & git.exe -C $Root worktree remove --force $ProofRoot *> $null
    if($LASTEXITCODE -ne 0){throw "M10_DEPLOYMENT_PROOF_CLEANUP_FAILED"}
  }
}
if(Test-Path -LiteralPath $ProofRoot){throw "M10_DEPLOYMENT_PROOF_RESIDUE"}

Write-Host "[5] Non-live production preflight"
& pwsh -NoProfile -File $PreflightPath -EvidenceRoot $PreflightRelative -Mode Fixture
Require-Exit "M10_NON_LIVE_PREFLIGHT"
$PreflightRoot=Join-Path $EvidenceRoot "preflight"
$PreimagePath=Join-Path $PreflightRoot "production-preimage.json"
$AclPath=Join-Path $PreflightRoot "acl-fixture-result.json"
$TaskPath=Join-Path $PreflightRoot "task-scheduler-feasibility.json"
$ComposePath=Join-Path $PreflightRoot "compose-render-result.json"
foreach($path in @($PreimagePath,$AclPath,$TaskPath,$ComposePath)){if(-not(Test-Path -LiteralPath $path)){throw "M10_PREFLIGHT_EVIDENCE_MISSING"}}
$Preimage=Get-Content -Raw $PreimagePath|ConvertFrom-Json
if([string]$Preimage.operator_compose_sha256 -ne $OperatorComposeSha){throw "M10_OPERATOR_COMPOSE_PREIMAGE_DRIFT"}
if([string]$Preimage.dedicated_compose_sha256 -ne $DedicatedComposeSha){throw "M10_DEDICATED_COMPOSE_PREIMAGE_DRIFT"}
if([bool]$Preimage.scheduled_task_present){throw "M10_TASK_COLLISION"}

Write-Host "[6] Disposable READ_ONLY_EMERGENCY direct + dev-proxy parity"
New-Item -ItemType Directory -Force $RuntimeRoot|Out-Null
$ParityResult=Join-Path $EvidenceRoot "m10-readonly-parity-result.json"
& node.exe (Join-Path $Root "scripts\live-m10-readonly-parity.mjs") $RuntimeRoot $ParityResult $DirectPort $ProxyPort
Require-Exit "M10_READONLY_PARITY"
$Parity=Get-Content -Raw $ParityResult|ConvertFrom-Json
$ParityFields=@("directExactToolSurface","directStatusPassed","directCapabilitiesPassed","directMutationDenied","tunnelExactToolSurface","tunnelStatusPassed","tunnelCapabilitiesPassed","tunnelMutationDenied","tunnelContainerRemoved","tunnelLogsSecretFree","apiKeyFileRemoved")
foreach($field in $ParityFields){if(-not [bool]$Parity.$field){throw "M10_PARITY_GATE_FAILED:$field"}}
Remove-Item -LiteralPath $RuntimeRoot -Recurse -Force -ErrorAction SilentlyContinue
if(Test-Path -LiteralPath $RuntimeRoot){throw "M10_RUNTIME_RESIDUE"}
if(Test-Port $DirectPort){throw "M10_PORT_8774_NOT_FREE"}
if(Test-Port $ProxyPort){throw "M10_PORT_18774_NOT_FREE"}
if((Get-LabeledContainerResidue "haios.m10.owner=readonly-parity").Count -ne 0){throw "M10_PREEXISTING_CONTAINER_RESIDUE"}
if(Test-Path -LiteralPath $DeploymentRoot){throw "M10_DEPLOYMENT_ROOT_COLLISION"}
if(Test-Path -LiteralPath $StateRoot){throw "M10_STATE_ROOT_COLLISION"}
if(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue){throw "M10_TASK_COLLISION"}
try{$healthPost=Invoke-RestMethod -Uri "http://127.0.0.1:8769/healthz" -TimeoutSec 3}catch{throw "M10_PREEXISTING_OPERATOR_HEALTH_UNAVAILABLE"}
if([string]$healthPost.mode -ne "READ_ONLY_EMERGENCY"){throw "M10_PREEXISTING_OPERATOR_NOT_EMERGENCY"}
$Listener8768Post=@(Get-ListenerIdentity 8768)
$Listener8769Post=@(Get-ListenerIdentity 8769)
if(($Listener8768Pre -join ',') -ne ($Listener8768Post -join ',')){throw "M10_SECURE_8768_DRIFT"}
if(($Listener8769Pre -join ',') -ne ($Listener8769Post -join ',')){throw "M10_LISTENER_8769_DRIFT"}
$ContainerPostEvidence=@()
foreach($name in $Containers){
  $post=Get-ContainerIntegrityDigest $name
  if($post -ne $ContainerPre[$name]){
    if($name -eq "haios-tunnel-client"){throw "M10_SHARED_TUNNEL_DRIFT"}
    throw "M10_LONG_LIVED_CONTAINER_DRIFT:$name"
  }
  $ContainerPostEvidence += [ordered]@{name=$name;pre_sha256=$ContainerPre[$name];post_sha256=$post;match=$true}
}
if((Get-Sha256 $ExecutorPath) -ne $ExecutorSha){throw "M10_EXECUTOR_HASH_DRIFT"}
if((Get-Sha256 $RollbackPath) -ne $RollbackSha){throw "M10_ROLLBACK_HASH_DRIFT"}
if((Get-Sha256 $PreflightPath) -ne $PreflightSha){throw "M10_PREFLIGHT_HASH_DRIFT"}
if((Get-Sha256 $LiveQualifierPath) -ne $LiveQualifierSha){throw "M10_LIVE_QUALIFIER_HASH_DRIFT"}
if((Get-Sha256 $StrictLauncherPath) -ne $StrictLauncherSha){throw "M10_STRICT_LAUNCHER_HASH_DRIFT"}
if((Get-Sha256 $StrictSupervisorPath) -ne $StrictSupervisorSha){throw "M10_STRICT_SUPERVISOR_HASH_DRIFT"}
if((Get-Sha256 $OperatorCompose) -ne $OperatorComposeSha){throw "M10_OPERATOR_COMPOSE_DRIFT"}
if((Get-Sha256 $DedicatedCompose) -ne $DedicatedComposeSha){throw "M10_DEDICATED_COMPOSE_DRIFT"}
$ManifestPostPath=Join-Path $EvidenceRoot "source-manifest-post-probe.txt"
$ManifestPost=Write-Manifest $ManifestPostPath
if($ManifestPost -ne $ManifestDigest){throw "M10_SOURCE_MANIFEST_DRIFT"}
if((git status --porcelain).Length -ne 0){throw "WORKTREE_NOT_CLEAN"}
$preContainerMap=@{}
foreach($binding in @($Preimage.containers)){$preContainerMap[[string]$binding.name]=[string]$binding.sha256}
foreach($name in $Containers){if($preContainerMap[$name] -ne $ContainerPre[$name]){throw "M10_PREFLIGHT_CONTAINER_PREIMAGE_DRIFT:$name"}}
if((@($Preimage.listener_8768)-join ',') -ne ($Listener8768Pre -join ',')){throw "M10_PREFLIGHT_8768_PREIMAGE_DRIFT"}
if((@($Preimage.listener_8769)-join ',') -ne ($Listener8769Pre -join ',')){throw "M10_PREFLIGHT_8769_PREIMAGE_DRIFT"}
$Acl=Get-Content -Raw $AclPath|ConvertFrom-Json
if(-not ([bool]$Acl.inherited_protected -and [bool]$Acl.current_operator_present -and [bool]$Acl.system_present -and [bool]$Acl.administrators_present -and [bool]$Acl.world_absent -and [bool]$Acl.builtin_users_absent)){throw "M10_ACL_FIXTURE_FAILED"}
$Task=Get-Content -Raw $TaskPath|ConvertFrom-Json
if([bool]$Task.task_registered -or [string]$Task.logon_type -ne "Interactive" -or [string]$Task.run_level -ne "Limited"){throw "M10_TASK_FEASIBILITY_FAILED"}
if(-not [bool]$Task.supervisor_bound -or -not ([string]$Task.action_argument).Contains("run-m10-readonly-supervisor.mjs")){throw "M10_TASK_SUPERVISOR_DRIFT"}
if([bool]$Task.disallow_start_if_on_batteries -or [bool]$Task.stop_if_going_on_batteries -or [string]$Task.execution_time_limit -ne "PT0S" -or [int]$Task.restart_count -ne 3 -or [string]$Task.restart_interval -ne "PT1M"){throw "M10_TASK_LONGEVITY_DRIFT"}
$Compose=Get-Content -Raw $ComposePath|ConvertFrom-Json
if(-not ([bool]$Compose.operator_host_port_removed -and [bool]$Compose.dedicated_target_host_runtime -and [bool]$Compose.dedicated_api_key_mount -and [bool]$Compose.dedicated_file_backed_header) -or [bool]$Compose.shared_tunnel_compose_touched){throw "M10_COMPOSE_RENDER_CONTRACT_FAILED"}
$SecretPatterns=@('(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{20,}','(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}','(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}','BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY')
foreach($file in (Get-ChildItem -LiteralPath $EvidenceRoot -Recurse -File -ErrorAction SilentlyContinue)){
  $text=[IO.File]::ReadAllText($file.FullName)
  foreach($pattern in $SecretPatterns){if($text -match $pattern){throw "M10_SECRET_EVIDENCE_LEAK"}}
}
Write-Host "M10_NON_LIVE_CURRENTNESS=PASS"
$PreimageSha=Get-Sha256 $PreimagePath
$Result=[ordered]@{
  mission="HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_STAGED_READ_ONLY_CUTOVER";run_id=$RunId;head=$Head;branch=$Branch
  parent_m09_head=$ParentHead;parent_m09_final_cert_sha256=$ParentCertSha;origin_main=$RemoteMain
  source_manifest_sha256=$ManifestDigest;full_test_files=$FullFiles;full_tests=$FullTests
  focused_tests="PASS";typecheck="PASS";build="PASS";non_live_preflight="PASS";readonly_parity="PASS"
  production_preimage_sha256=$PreimageSha;long_lived_containers=@($ContainerPostEvidence)
  listener_8768=@($Listener8768Pre);listener_8769=@($Listener8769Pre);operator_mode="READ_ONLY_EMERGENCY"
  production_mutation_performed=$false;task_created=$false;secret_created=$false;tunnel_reconfigured=$false
  active_authorized=$false;s2_enabled=$false;destructive="LOCKED"
  terminal="HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_READY_FOR_EXACT_HUMAN_READ_ONLY_CUTOVER_DECISION"
}
$ResultPath=Join-Path $EvidenceRoot "m10-prelive-qualification-result.json"
Write-JsonNoBom $ResultPath $Result
$Envelope=[ordered]@{
  mission=$Result.mission;run_id=$RunId;environment="PRODUCTION"
  candidate_head=$Head;candidate_manifest_sha256=$ManifestDigest
  parent_cert_sha256=$ParentCertSha;required_human_decision=$ExactDecision;human_decision_received=$false
  executor_sha256=$ExecutorSha;rollback_sha256=$RollbackSha;preflight_sha256=$PreflightSha
  live_qualifier_sha256=$LiveQualifierSha;strict_launcher_sha256=$StrictLauncherSha;strict_supervisor_sha256=$StrictSupervisorSha
  operator_compose_sha256=$OperatorComposeSha;dedicated_compose_sha256=$DedicatedComposeSha
  production_preimage_sha256=$PreimageSha;container_digests=@($ContainerPreEvidence)
  dedicated_control_key_file=$DedicatedControlKeyFile;dedicated_control_key_file_sha256=$DedicatedControlKeySha
  shared_tunnel_sha256=$SharedTunnelSha;listener_8768=@($Listener8768Pre);listener_8769=@($Listener8769Pre)
  operator_mode_precondition="READ_ONLY_EMERGENCY";full_test_files=$FullFiles;full_tests=$FullTests
  production_mutation_performed=$false;task_created=$false;secret_created=$false;tunnel_reconfigured=$false
  shared_tunnel_preserved=$true;secure_8768_preserved=$true;rollback_prequalified=$true
  active_authorized=$false;s2_enabled=$false;destructive="LOCKED"
}
$EnvelopePath=Join-Path $EvidenceRoot "human-read-only-cutover-decision-envelope.json"
Write-JsonNoBom $EnvelopePath $Envelope
$EnvelopeSha=Get-Sha256 $EnvelopePath
[IO.File]::WriteAllText((Join-Path $EvidenceRoot "human-read-only-cutover-decision-envelope.sha256"),"$EnvelopeSha  human-read-only-cutover-decision-envelope.json`n",[Text.UTF8Encoding]::new($false))
$Seal=[ordered]@{
  envelope_sha256=$EnvelopeSha;qualification_result_sha256=(Get-Sha256 $ResultPath)
  candidate_head=$Head;candidate_manifest_sha256=$ManifestDigest
  production_mutation_performed=$false;human_decision_received=$false
  required_human_decision=$ExactDecision
  terminal="HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_READY_FOR_EXACT_HUMAN_READ_ONLY_CUTOVER_DECISION"
}
Write-JsonNoBom (Join-Path $EvidenceRoot "m10-prelive-seal.json") $Seal
Write-Host "RESULT_PATH=$ResultPath"
Write-Host "DECISION_ENVELOPE=$EnvelopePath"
Write-Host "DECISION_ENVELOPE_SHA256=$EnvelopeSha"
Write-Host "HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_READY_FOR_EXACT_HUMAN_READ_ONLY_CUTOVER_DECISION" -ForegroundColor Green
