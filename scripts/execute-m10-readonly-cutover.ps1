param(
  [Parameter(Mandatory=$true)][string]$DecisionEnvelope,
  [Parameter(Mandatory=$true)][string]$HumanDecision,
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
$ParentCert = "C:\Workspace\haios-desktop-control-m09\evidence\m09\20260828T151328Z\m09-final-certification.json"
$RollbackScript = Join-Path $Root "scripts\rollback-m10-readonly-cutover.ps1"
$StrictLauncher = "run-m10-readonly-runtime.mjs"
$ExactDecision = "APPROVE HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_STAGED_READ_ONLY_CUTOVER"
$SyntheticDecision = "SYNTHETIC_M10_CUTOVER_TEST_ONLY"
function Get-Sha256([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }
function Write-JsonNoBom([string]$Path,$Object) { [IO.File]::WriteAllText($Path,(($Object|ConvertTo-Json -Depth 16)+"`n"),[Text.UTF8Encoding]::new($false)) }
function Get-ListenerIdentity([int]$PortNumber) {
  @((Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue |
    Sort-Object LocalAddress,OwningProcess | ForEach-Object { "$($_.LocalAddress)|$($_.LocalPort)|$($_.OwningProcess)" }))
}
function Get-ContainerIntegrityDigest([string]$Name) {
  $Raw=& docker.exe inspect $Name 2>$null
  if($LASTEXITCODE -ne 0 -or -not $Raw){throw "M10_CONTAINER_UNAVAILABLE:$Name"}
  $o=($Raw|ConvertFrom-Json)[0]
  $net=@($o.NetworkSettings.Networks.PSObject.Properties|Sort-Object Name|ForEach-Object{[ordered]@{name=$_.Name;network_id=$_.Value.NetworkID;endpoint_id=$_.Value.EndpointID;ip=$_.Value.IPAddress;gateway=$_.Value.Gateway}})
  $mount=@($o.Mounts|Sort-Object Destination,Type|ForEach-Object{[ordered]@{type=$_.Type;destination=$_.Destination;mode=$_.Mode;rw=$_.RW;propagation=$_.Propagation}})
  $snap=[ordered]@{id=$o.Id;created=$o.Created;image_id=$o.Image;config_image=$o.Config.Image;path=$o.Path;args=@($o.Args);network_mode=$o.HostConfig.NetworkMode;restart_policy=$o.HostConfig.RestartPolicy;mounts=$mount;networks=$net}
  $bytes=[Text.Encoding]::UTF8.GetBytes(($snap|ConvertTo-Json -Depth 8 -Compress))
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
function Get-ManifestDigest([string]$RepoRoot) {
  $paths=[string[]]@(& git.exe -C $RepoRoot ls-files); if($LASTEXITCODE -ne 0){throw "M10_MANIFEST_ENUM_FAILED"}; [Array]::Sort($paths,[StringComparer]::Ordinal)
  $lines=foreach($rel in $paths){"$(Get-Sha256 (Join-Path $RepoRoot $rel))  $($rel.Replace('\','/'))"}
  $text=($lines -join "`n")+"`n"; $bytes=[Text.Encoding]::UTF8.GetBytes($text)
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
$DecisionEnvelope=[IO.Path]::GetFullPath($DecisionEnvelope)
$EvidenceRoot=[IO.Path]::GetFullPath($EvidenceRoot)
if(-not(Test-Path -LiteralPath $DecisionEnvelope)){throw "M10_CUTOVER_AUTHORITY_CURRENTNESS_FAILED:DECISION_MISSING"}
New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null
$JournalPath=Join-Path $EvidenceRoot "m10-execution-journal.jsonl"
$Envelope=Get-Content -Raw -LiteralPath $DecisionEnvelope|ConvertFrom-Json
$Environment=[string]$Envelope.environment
$mutationStarted=$false
function Write-Journal([string]$Event,$Data=$null){
  $record=[ordered]@{utc=[DateTime]::UtcNow.ToString("o");event=$Event}
  if($null -ne $Data){$record.data=$Data}
  [IO.File]::AppendAllText($JournalPath,(($record|ConvertTo-Json -Depth 10 -Compress)+"`n"),[Text.UTF8Encoding]::new($false))
}
function AuthorityFail([string]$Why){throw "M10_CUTOVER_AUTHORITY_CURRENTNESS_FAILED:$Why"}

if($Environment -notin @("SYNTHETIC","PRODUCTION")){AuthorityFail "ENVIRONMENT_INVALID"}
$expectedDecision=if($Environment -eq "SYNTHETIC"){$SyntheticDecision}else{$ExactDecision}
if([string]$Envelope.required_human_decision -ne $expectedDecision){AuthorityFail "REQUIRED_DECISION_MISMATCH"}
if($HumanDecision -ne $expectedDecision){AuthorityFail "HUMAN_DECISION_MISMATCH"}
if((Get-Sha256 $PSCommandPath) -ne [string]$Envelope.executor_sha256){AuthorityFail "EXECUTOR_HASH_DRIFT"}
if((Get-Sha256 $RollbackScript) -ne [string]$Envelope.rollback_sha256){AuthorityFail "ROLLBACK_HASH_DRIFT"}

if($Environment -eq "SYNTHETIC"){
  foreach($p in @("operator-compose.yml","dedicated-compose.yml")){if(-not(Test-Path (Join-Path $SyntheticRoot $p))){AuthorityFail "SYNTHETIC_FIXTURE_MISSING"}}
}else{
  if([string]$Envelope.parent_cert_sha256 -ne (Get-Sha256 $ParentCert)){AuthorityFail "PARENT_CERT_DRIFT"}
  if([string]$Envelope.operator_compose_sha256 -ne (Get-Sha256 $OperatorCompose)){AuthorityFail "OPERATOR_COMPOSE_DRIFT"}
  if([string]$Envelope.dedicated_compose_sha256 -ne (Get-Sha256 $DedicatedCompose)){AuthorityFail "DEDICATED_COMPOSE_DRIFT"}
  $head=(& git.exe -C $Root rev-parse HEAD).Trim(); if($LASTEXITCODE -ne 0){AuthorityFail "HEAD_READ_FAILED"}
  if($head -ne [string]$Envelope.candidate_head){AuthorityFail "HEAD_DRIFT"}
  if((Get-ManifestDigest $Root) -ne [string]$Envelope.candidate_manifest_sha256){AuthorityFail "MANIFEST_DRIFT"}
  if((& git.exe -C $Root status --porcelain).Length -ne 0){AuthorityFail "WORKTREE_NOT_CLEAN"}
  foreach($binding in @($Envelope.container_digests)){
    if((Get-ContainerIntegrityDigest ([string]$binding.name)) -ne [string]$binding.sha256){AuthorityFail "CONTAINER_DRIFT:$($binding.name)"}
  }
  if((@(Get-ListenerIdentity 8768)-join ',') -ne (@($Envelope.listener_8768)-join ',')){AuthorityFail "LISTENER_8768_DRIFT"}
  if((@(Get-ListenerIdentity 8769)-join ',') -ne (@($Envelope.listener_8769)-join ',')){AuthorityFail "LISTENER_8769_DRIFT"}
  try{$h=Invoke-RestMethod -Uri "http://127.0.0.1:8769/healthz" -TimeoutSec 3}catch{AuthorityFail "OPERATOR_HEALTH_UNAVAILABLE"}
  if([string]$h.mode -ne "READ_ONLY_EMERGENCY"){AuthorityFail "OPERATOR_MODE_NOT_EMERGENCY"}
  if(Test-Path -LiteralPath $DeploymentRoot){AuthorityFail "DEPLOYMENT_ROOT_COLLISION"}
  if(Test-Path -LiteralPath $StateRoot){AuthorityFail "STATE_ROOT_COLLISION"}
  if(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue){AuthorityFail "TASK_COLLISION"}
}

Write-Journal "M10_JOURNAL_READY" @{environment=$Environment}
Write-Journal "M10_HUMAN_AUTHORITY_ACCEPTED" @{decision_matched=$true}
try{
  Write-Journal "M10_MUTATION_BEGIN"
  $mutationStarted=$true
  if($Environment -eq "SYNTHETIC"){
    $op=Join-Path $SyntheticRoot "operator-compose.yml"; $ded=Join-Path $SyntheticRoot "dedicated-compose.yml"
    $opPre=Join-Path $SyntheticRoot "operator-compose.preimage.yml"; $dedPre=Join-Path $SyntheticRoot "dedicated-compose.preimage.yml"
    Copy-Item $op $opPre -Force; Copy-Item $ded $dedPre -Force
    [IO.File]::WriteAllText($op,"M10_SYNTHETIC_OPERATOR_POST`n",[Text.UTF8Encoding]::new($false))
    Write-Journal "M10_OLD_OPERATOR_HOST_PORT_REMOVED"
    Write-Journal "M10_DEPLOYMENT_WORKTREE_READY"
    Write-Journal "M10_SCHEDULED_TASK_STARTED"
    Write-Journal "M10_HOST_8769_EMERGENCY_READY"
    [IO.File]::WriteAllText($ded,"M10_SYNTHETIC_DEDICATED_POST`n",[Text.UTF8Encoding]::new($false))
    Write-Journal "M10_DEDICATED_TUNNEL_SWITCHED"
    & pwsh -NoProfile -File $RollbackScript -DecisionEnvelope $DecisionEnvelope -ExecutionJournal $JournalPath -EvidenceRoot $EvidenceRoot
    if($LASTEXITCODE -ne 0){throw "M10_SYNTHETIC_ROLLBACK_FAILED"}
    Write-Host "M10_SYNTHETIC_TRANSACTION_PASS"
    exit 0
  }
  function Wait-ContainerHealthy([string]$Name,[int]$Seconds=60){
    $deadline=[DateTime]::UtcNow.AddSeconds($Seconds)
    do{
      Start-Sleep -Milliseconds 500
      $status=(& docker.exe inspect --format '{{.State.Health.Status}}' $Name 2>$null).Trim()
      if($LASTEXITCODE -eq 0 -and $status -eq 'healthy'){return}
    }while([DateTime]::UtcNow -lt $deadline)
    throw "M10_CONTAINER_HEALTH_TIMEOUT:$Name"
  }

  $OperatorOverride=Join-Path $EvidenceRoot "operator-live.override.yml"
  @'
services:
  operator-mcp:
    ports: !reset []
'@ | Set-Content -LiteralPath $OperatorOverride -Encoding utf8NoBOM
  & docker.exe compose -p haios-operator-mcp -f $OperatorCompose -f $OperatorOverride up -d --no-deps --no-build --force-recreate operator-mcp
  if($LASTEXITCODE -ne 0){throw "M10_OPERATOR_PORT_HANDOFF_FAILED"}
  Wait-ContainerHealthy $OperatorContainer 60
  if(Get-NetTCPConnection -State Listen -LocalPort 8769 -ErrorAction SilentlyContinue){throw "M10_PORT_8769_NOT_RELEASED"}
  Write-Journal "M10_OLD_OPERATOR_HOST_PORT_REMOVED"

  & git.exe -C $Root worktree add --detach $DeploymentRoot ([string]$Envelope.candidate_head)
  if($LASTEXITCODE -ne 0){throw "M10_DEPLOYMENT_WORKTREE_CREATE_FAILED"}
  if((Get-ManifestDigest $DeploymentRoot) -ne [string]$Envelope.candidate_manifest_sha256){throw "M10_DEPLOYMENT_MANIFEST_DRIFT"}
  Push-Location $DeploymentRoot
  try{
    & npm.cmd ci --ignore-scripts --no-audit --no-fund; if($LASTEXITCODE -ne 0){throw "M10_DEPLOYMENT_NPM_CI_FAILED"}
    & npm.cmd run build; if($LASTEXITCODE -ne 0){throw "M10_DEPLOYMENT_BUILD_FAILED"}
  }finally{Pop-Location}
  Write-Journal "M10_DEPLOYMENT_WORKTREE_READY"
  function Set-M10StateAcl([string]$Path){
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    $security=[Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true,$false)
    $inherit=[Security.AccessControl.InheritanceFlags]"ContainerInherit,ObjectInherit"
    $prop=[Security.AccessControl.PropagationFlags]::None
    $allow=[Security.AccessControl.AccessControlType]::Allow
    $systemSid=[Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::LocalSystemSid,$null)
    $adminsSid=[Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid,$null)
    foreach($sid in @($identity.User,$systemSid,$adminsSid)){
      $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,$prop,$allow)
      $security.AddAccessRule($rule)|Out-Null
    }
    Set-Acl -LiteralPath $Path -AclObject $security
  }

  New-Item -ItemType Directory -Path $StateRoot | Out-Null
  Set-M10StateAcl $StateRoot
  $Worktrees=Join-Path $StateRoot "worktrees"; New-Item -ItemType Directory -Path $Worktrees | Out-Null
  $ApiKeyFile=Join-Path $StateRoot "operator-api-key"
  $SecretBytes=New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Fill($SecretBytes)
  $ApiKey=[Convert]::ToHexString($SecretBytes).ToLowerInvariant()
  [IO.File]::WriteAllText($ApiKeyFile,$ApiKey,[Text.UTF8Encoding]::new($false))
  $ConfigPath=Join-Path $StateRoot "host-config.json"
  $Config=[ordered]@{apiKeyFile=$ApiKeyFile;worktreeRoot=$Worktrees;allowedProjects=[ordered]@{};port=8769;mode="READ_ONLY_EMERGENCY"}
  Write-JsonNoBom $ConfigPath $Config

  $identityName=[Security.Principal.WindowsIdentity]::GetCurrent().Name
  $node="C:\Program Files\nodejs\node.exe"; $launcher=Join-Path $DeploymentRoot "scripts\$StrictLauncher"
  $action=New-ScheduledTaskAction -Execute $node -Argument "`"$launcher`" `"$ConfigPath`""
  $trigger=New-ScheduledTaskTrigger -AtLogOn -User $identityName
  $principal=New-ScheduledTaskPrincipal -UserId $identityName -LogonType Interactive -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $task=New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
  Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Write-Journal "M10_SCHEDULED_TASK_STARTED"

  $deadline=[DateTime]::UtcNow.AddSeconds(45); $hostHealth=$null
  do{
    Start-Sleep -Milliseconds 500
    try{$hostHealth=Invoke-RestMethod -Uri "http://127.0.0.1:8769/healthz" -TimeoutSec 2}catch{$hostHealth=$null}
  }while(($null -eq $hostHealth -or [string]$hostHealth.mode -ne "READ_ONLY_EMERGENCY") -and [DateTime]::UtcNow -lt $deadline)
  if($null -eq $hostHealth -or [string]$hostHealth.mode -ne "READ_ONLY_EMERGENCY"){throw "M10_HOST_8769_EMERGENCY_HEALTH_FAILED"}
  Write-Journal "M10_HOST_8769_EMERGENCY_READY"

  $dedicatedInspect=(& docker.exe inspect $DedicatedContainer | ConvertFrom-Json)[0]
  if($LASTEXITCODE -ne 0 -or -not $dedicatedInspect){throw "M10_DEDICATED_CONTAINER_MISSING"}
  $controlMount=@($dedicatedInspect.Mounts|Where-Object{$_.Destination -eq "/run/secrets/control-plane-api-key"})[0]
  if(-not $controlMount -or -not $controlMount.Source){throw "M10_CONTROL_PLANE_MOUNT_UNAVAILABLE"}
  $env:HAIOS_OPERATOR_TUNNEL_RUNTIME_KEY_FILE=[string]$controlMount.Source
  $baseJson=& docker.exe compose -p haios-operator-dedicated-tunnel -f $DedicatedCompose config --format json
  if($LASTEXITCODE -ne 0){throw "M10_DEDICATED_BASE_RENDER_FAILED"}
  $service=($baseJson|ConvertFrom-Json).services.'operator-dedicated-tunnel-client'
  $command=@($service.command|ForEach-Object{[string]$_})
  $oldTarget="url=http://operator-mcp:8769/mcp,channel=main"; $newTarget="url=http://host.docker.internal:8769/mcp,channel=main"
  if(($command|Where-Object{$_.Contains($oldTarget)}).Count -ne 1){throw "M10_DEDICATED_TARGET_PREIMAGE_INVALID"}
  $command=@($command|ForEach-Object{if($_.Contains($oldTarget)){$_.Replace($oldTarget,$newTarget)}else{$_}})
  $DedicatedOverride=Join-Path $EvidenceRoot "dedicated-live.override.yml"
  $keySource=$ApiKeyFile.Replace('\','/')
  $lines=@(
    "services:",
    "  operator-dedicated-tunnel-client:",
    "    volumes:",
    "      - type: bind",
    "        source: $keySource",
    "        target: /run/secrets/m10-operator-api-key",
    "        read_only: true",
    "    environment:",
    '      MCP_EXTRA_HEADERS: "X-API-Key: file:/run/secrets/m10-operator-api-key"',
    "    command: !override"
  )
  foreach($arg in $command){$lines += "      - $($arg|ConvertTo-Json -Compress)"}
  [IO.File]::WriteAllText($DedicatedOverride,(($lines -join "`n")+"`n"),[Text.UTF8Encoding]::new($false))
  & docker.exe compose -p haios-operator-dedicated-tunnel -f $DedicatedCompose -f $DedicatedOverride up -d --no-deps --no-build --force-recreate operator-dedicated-tunnel-client
  if($LASTEXITCODE -ne 0){throw "M10_DEDICATED_TUNNEL_SWITCH_FAILED"}
  Wait-ContainerHealthy $DedicatedContainer 60
  Remove-Item Env:HAIOS_OPERATOR_TUNNEL_RUNTIME_KEY_FILE -ErrorAction SilentlyContinue
  $dedicatedPost=(& docker.exe inspect $DedicatedContainer | ConvertFrom-Json)[0]
  if(-not ((@($dedicatedPost.Args)-join ' ').Contains("host.docker.internal:8769/mcp"))){throw "M10_DEDICATED_ROUTE_POSTCHECK_FAILED"}
  Write-Journal "M10_DEDICATED_TUNNEL_SWITCHED"

  $sharedBinding=@($Envelope.container_digests|Where-Object{$_.name -eq $SharedTunnelContainer})[0]
  if(-not $sharedBinding -or (Get-ContainerIntegrityDigest $SharedTunnelContainer) -ne [string]$sharedBinding.sha256){throw "M10_SHARED_TUNNEL_DRIFT"}
  if((@(Get-ListenerIdentity 8768)-join ',') -ne (@($Envelope.listener_8768)-join ',')){throw "M10_SECURE_8768_DRIFT"}
  $result=[ordered]@{environment="PRODUCTION";candidate_head=[string]$Envelope.candidate_head;mode="READ_ONLY_EMERGENCY";old_operator_internal_healthy=$true;host_8769_ready=$true;dedicated_tunnel_switched=$true;shared_tunnel_unchanged=$true;secure_8768_unchanged=$true;secret_value_persisted_in_evidence=$false}
  Write-JsonNoBom (Join-Path $EvidenceRoot "m10-cutover-result.json") $result
  Write-Journal "M10_FORWARD_TRANSACTION_COMPLETE"
  Write-Host "M10_READ_ONLY_CUTOVER_FORWARD_COMPLETE"
}catch{
  $forwardError=$_.Exception.Message
  Write-Journal "M10_FORWARD_FAILURE" @{error=$forwardError}
  if($mutationStarted){
    try{
      & pwsh -NoProfile -File $RollbackScript -DecisionEnvelope $DecisionEnvelope -ExecutionJournal $JournalPath -EvidenceRoot $EvidenceRoot
      if($LASTEXITCODE -ne 0){throw "ROLLBACK_EXIT_$LASTEXITCODE"}
      Write-Journal "M10_AUTOMATIC_ROLLBACK_COMPLETE"
    }catch{
      Write-Journal "M10_AUTOMATIC_ROLLBACK_BLOCKED" @{error=$_.Exception.Message}
      throw "M10_FORWARD_FAILED_ROLLBACK_BLOCKED:$forwardError"
    }
  }
  throw "M10_FORWARD_FAILED_ROLLED_BACK:$forwardError"
}finally{
  Remove-Item Env:HAIOS_OPERATOR_TUNNEL_RUNTIME_KEY_FILE -ErrorAction SilentlyContinue
}
