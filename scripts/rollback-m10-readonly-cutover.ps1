param(
  [Parameter(Mandatory=$true)][string]$DecisionEnvelope,
  [Parameter(Mandatory=$true)][string]$ExecutionJournal,
  [Parameter(Mandatory=$true)][string]$EvidenceRoot
)
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
if ($PSVersionTable.PSVersion.Major -lt 7) { throw "POWERSHELL_7_REQUIRED" }
$Root = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$OperatorCompose = "C:\Workspace\haios-operator-mcp\docker-compose.operator.yml"
$DedicatedCompose = "C:\Workspace\haios-operator-mcp\docker-compose.operator-dedicated-tunnel.yml"
$DeploymentRoot = "C:\Workspace\haios-desktop-control-runtime"
$StateRoot = Join-Path $env:LOCALAPPDATA "HAIOS\M10"
$TaskName = "HAIOS-M10-Operator-ReadOnly"
$OperatorContainer = "haios-operator-mcp"
$DedicatedContainer = "haios-operator-dedicated-tunnel-client"
$SharedTunnelContainer = "haios-tunnel-client"
$SyntheticRoot = Join-Path $Root "runtime\m10-cutover-fixture"
$ExactDecision = "APPROVE HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_STAGED_READ_ONLY_CUTOVER"
$SyntheticDecision = "SYNTHETIC_M10_CUTOVER_TEST_ONLY"

function Get-Sha256([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }
function Write-JsonNoBom([string]$Path,$Object) { [IO.File]::WriteAllText($Path,(($Object|ConvertTo-Json -Depth 12)+"`n"),[Text.UTF8Encoding]::new($false)) }
function Get-ListenerIdentity([int]$PortNumber) {
  @((Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue |
    Sort-Object LocalAddress,OwningProcess | ForEach-Object { "$($_.LocalAddress)|$($_.LocalPort)|$($_.OwningProcess)" }))
}
function Get-ContainerIntegrityDigest([string]$Name) {
  $raw=& docker.exe inspect $Name 2>$null
  if($LASTEXITCODE -ne 0 -or -not $raw){throw "M10_CONTAINER_UNAVAILABLE:$Name"}
  $o=($raw|ConvertFrom-Json)[0]
  $net=@($o.NetworkSettings.Networks.PSObject.Properties|Sort-Object Name|ForEach-Object{[ordered]@{name=$_.Name;network_id=$_.Value.NetworkID;endpoint_id=$_.Value.EndpointID;ip=$_.Value.IPAddress;gateway=$_.Value.Gateway}})
  $mount=@($o.Mounts|Sort-Object Destination,Type|ForEach-Object{[ordered]@{type=$_.Type;destination=$_.Destination;mode=$_.Mode;rw=$_.RW;propagation=$_.Propagation}})
  $snap=[ordered]@{id=$o.Id;created=$o.Created;image_id=$o.Image;config_image=$o.Config.Image;path=$o.Path;args=@($o.Args);network_mode=$o.HostConfig.NetworkMode;restart_policy=$o.HostConfig.RestartPolicy;mounts=$mount;networks=$net}
  $bytes=[Text.Encoding]::UTF8.GetBytes(($snap|ConvertTo-Json -Depth 8 -Compress))
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
function Block([string]$Why) { throw "M10_ROLLBACK_CURRENTNESS_BLOCKED:$Why" }
$DecisionEnvelope = [IO.Path]::GetFullPath($DecisionEnvelope)
$ExecutionJournal = [IO.Path]::GetFullPath($ExecutionJournal)
$EvidenceRoot = [IO.Path]::GetFullPath($EvidenceRoot)
if (-not (Test-Path -LiteralPath $DecisionEnvelope)) { Block "DECISION_MISSING" }
if (-not (Test-Path -LiteralPath $ExecutionJournal)) { Block "JOURNAL_MISSING" }
New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null
$Envelope = Get-Content -Raw -LiteralPath $DecisionEnvelope | ConvertFrom-Json
$Environment = [string]$Envelope.environment
$ExpectedDecision = if ($Environment -eq "SYNTHETIC") { $SyntheticDecision } else { $ExactDecision }
if ([string]$Envelope.required_human_decision -ne $ExpectedDecision) { Block "REQUIRED_DECISION_MISMATCH" }
if ($Environment -notin @("SYNTHETIC","PRODUCTION")) { Block "ENVIRONMENT_INVALID" }
$JournalText = Get-Content -Raw -LiteralPath $ExecutionJournal
if (-not $JournalText.Contains("M10_HUMAN_AUTHORITY_ACCEPTED")) { Block "AUTHORITY_JOURNAL_MISSING" }

# execution_journal_sha256 is recomputed at rollback entry; a sealed decision cannot pre-bind future journal bytes.
$JournalSha = Get-Sha256 $ExecutionJournal
$RollbackResult = [ordered]@{
  environment=$Environment
  execution_journal_sha256=$JournalSha
  dedicated_restored=$false
  task_removed=$false
  operator_restored=$false
  deployment_removed=$false
  state_removed=$false
  shared_tunnel_preserved=$false
  secure_8768_preserved=$false
}

if ($Environment -eq "SYNTHETIC") {
  $op = Join-Path $SyntheticRoot "operator-compose.yml"
  $ded = Join-Path $SyntheticRoot "dedicated-compose.yml"
  $opPre = Join-Path $SyntheticRoot "operator-compose.preimage.yml"
  $dedPre = Join-Path $SyntheticRoot "dedicated-compose.preimage.yml"
  foreach($p in @($op,$ded,$opPre,$dedPre)){ if(-not(Test-Path -LiteralPath $p)){ Block "SYNTHETIC_PREIMAGE_MISSING" } }
  Copy-Item -LiteralPath $dedPre -Destination $ded -Force
  $RollbackResult.dedicated_restored=$true
  $RollbackResult.task_removed=$true
  Copy-Item -LiteralPath $opPre -Destination $op -Force
  $RollbackResult.operator_restored=$true
  $RollbackResult.deployment_removed=$true
  $RollbackResult.state_removed=$true
  if ((Get-Sha256 $op) -ne (Get-Sha256 $opPre) -or (Get-Sha256 $ded) -ne (Get-Sha256 $dedPre)) {
    Block "SYNTHETIC_BYTE_RESTORE_FAILED"
  }
  Write-JsonNoBom (Join-Path $EvidenceRoot "rollback-result.json") $RollbackResult
  Write-Host "HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_ROLLED_BACK_TO_CERTIFIED_M09_READ_ONLY_STATE"
  exit 0
}

if ((Get-Sha256 $OperatorCompose) -ne [string]$Envelope.operator_compose_sha256) { Block "OPERATOR_COMPOSE_DRIFT" }
if ((Get-Sha256 $DedicatedCompose) -ne [string]$Envelope.dedicated_compose_sha256) { Block "DEDICATED_COMPOSE_DRIFT" }
if ((Get-Sha256 $PSCommandPath) -ne [string]$Envelope.rollback_sha256) { Block "ROLLBACK_SCRIPT_DRIFT" }

$ControlPlaneKeyFile=[string]$Envelope.dedicated_control_key_file
$ControlPlaneKeySha=[string]$Envelope.dedicated_control_key_file_sha256
$SharedTunnelSha=[string]$Envelope.shared_tunnel_sha256
$Expected8768=@($Envelope.listener_8768)
if([string]::IsNullOrWhiteSpace($ControlPlaneKeyFile) -or [string]::IsNullOrWhiteSpace($ControlPlaneKeySha)) { Block "M10_DEDICATED_CONTROL_KEY_BINDING_MISSING" }
try { $ControlPlaneKeyFile=[IO.Path]::GetFullPath($ControlPlaneKeyFile) } catch { Block "M10_DEDICATED_CONTROL_KEY_BINDING_MISSING" }
if(-not(Test-Path -LiteralPath $ControlPlaneKeyFile -PathType Leaf)) { Block "M10_DEDICATED_CONTROL_KEY_BINDING_MISSING" }
if((Get-Sha256 $ControlPlaneKeyFile) -ne $ControlPlaneKeySha) { Block "M10_DEDICATED_CONTROL_KEY_DRIFT" }
if([string]::IsNullOrWhiteSpace($SharedTunnelSha) -or $Expected8768.Count -eq 0) { Block "M10_PRESERVATION_BINDING_MISSING" }

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  $expectedSupervisor = Join-Path $DeploymentRoot "scripts\run-m10-readonly-supervisor.mjs"
  $action = @($task.Actions)[0]
  if (-not ([string]$action.Arguments).Contains($expectedSupervisor)) { Block "TASK_IDENTITY_DRIFT" }
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
$RollbackResult.task_removed=$true

$portDeadline=[DateTime]::UtcNow.AddSeconds(15)
do {
  $port8769=@(Get-ListenerIdentity 8769)
  if($port8769.Count -eq 0){break}
  Start-Sleep -Milliseconds 250
} while([DateTime]::UtcNow -lt $portDeadline)
if($port8769.Count -ne 0) { Block "M10_ROLLBACK_8769_NOT_FREE" }

& docker.exe compose -p haios-operator-mcp -f $OperatorCompose up -d --no-deps --no-build --force-recreate operator-mcp
if ($LASTEXITCODE -ne 0) { Block "OPERATOR_RESTORE_FAILED" }
$deadline = [DateTime]::UtcNow.AddSeconds(45)
do {
  Start-Sleep -Milliseconds 500
  try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:8769/healthz" -TimeoutSec 2 } catch { $health = $null }
} while (($null -eq $health -or [string]$health.mode -ne "READ_ONLY_EMERGENCY") -and [DateTime]::UtcNow -lt $deadline)
if ($null -eq $health -or [string]$health.mode -ne "READ_ONLY_EMERGENCY") { Block "OPERATOR_EMERGENCY_HEALTH_FAILED" }
$RollbackResult.operator_restored=$true

try {
  $env:HAIOS_OPERATOR_TUNNEL_RUNTIME_KEY_FILE=$ControlPlaneKeyFile
  & docker.exe compose -p haios-operator-dedicated-tunnel -f $DedicatedCompose up -d --no-deps --no-build --force-recreate operator-dedicated-tunnel-client
  if ($LASTEXITCODE -ne 0) { Block "DEDICATED_RESTORE_FAILED" }
} finally {
  Remove-Item Env:HAIOS_OPERATOR_TUNNEL_RUNTIME_KEY_FILE -ErrorAction SilentlyContinue
}
$dedicatedPost=(& docker.exe inspect $DedicatedContainer 2>$null | ConvertFrom-Json)[0]
if(-not $dedicatedPost) { Block "M10_DEDICATED_RESTORE_FAILED" }
$argsText=(@($dedicatedPost.Args)-join " ")
if(-not $argsText.Contains("operator-mcp:8769/mcp") -or $argsText.Contains("host.docker.internal:8769/mcp")) { Block "M10_DEDICATED_RESTORE_ROUTE_FAILED" }
$controlMount=@($dedicatedPost.Mounts|Where-Object{$_.Destination -eq "/run/secrets/control-plane-api-key"})[0]
if(-not $controlMount -or -not $controlMount.Source -or [IO.Path]::GetFullPath([string]$controlMount.Source) -ne $ControlPlaneKeyFile) { Block "M10_DEDICATED_RESTORE_MOUNT_FAILED" }
if(@($dedicatedPost.Mounts|Where-Object{$_.Destination -eq "/run/secrets/m10-operator-api-key"}).Count -ne 0) { Block "M10_DEDICATED_RESTORE_M10_KEY_RESIDUE" }
$dedicatedDeadline=[DateTime]::UtcNow.AddSeconds(60)
$dedicatedHealth=""
do {
  $dedicatedHealth=(& docker.exe inspect --format '{{.State.Health.Status}}' $DedicatedContainer 2>$null).Trim()
  if($LASTEXITCODE -eq 0 -and $dedicatedHealth -eq "healthy"){break}
  Start-Sleep -Milliseconds 500
} while([DateTime]::UtcNow -lt $dedicatedDeadline)
if($dedicatedHealth -ne "healthy") { Block "M10_DEDICATED_RESTORE_HEALTH_FAILED" }
$RollbackResult.dedicated_restored=$true

if((Get-ContainerIntegrityDigest $SharedTunnelContainer) -ne $SharedTunnelSha) { Block "M10_ROLLBACK_SHARED_TUNNEL_DRIFT" }
if((@(Get-ListenerIdentity 8768)-join ',') -ne ($Expected8768-join ',')) { Block "M10_ROLLBACK_8768_DRIFT" }
$RollbackResult.shared_tunnel_preserved=$true
$RollbackResult.secure_8768_preserved=$true

if (Test-Path -LiteralPath $DeploymentRoot) {
  & git.exe -C $Root worktree remove --force $DeploymentRoot
  if ($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath $DeploymentRoot)) { Block "DEPLOYMENT_REMOVE_FAILED" }
}
$RollbackResult.deployment_removed=$true

if (Test-Path -LiteralPath $StateRoot) {
  Remove-Item -LiteralPath $StateRoot -Recurse -Force
  if (Test-Path -LiteralPath $StateRoot) { Block "STATE_REMOVE_FAILED" }
}
$RollbackResult.state_removed=$true

if((Get-ContainerIntegrityDigest $SharedTunnelContainer) -ne $SharedTunnelSha) { Block "M10_ROLLBACK_SHARED_TUNNEL_DRIFT" }
if((@(Get-ListenerIdentity 8768)-join ',') -ne ($Expected8768-join ',')) { Block "M10_ROLLBACK_8768_DRIFT" }
Write-JsonNoBom (Join-Path $EvidenceRoot "rollback-result.json") $RollbackResult
Write-Host "HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_ROLLED_BACK_TO_CERTIFIED_M09_READ_ONLY_STATE"
