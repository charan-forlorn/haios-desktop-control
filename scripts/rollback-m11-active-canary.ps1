param(
  [Parameter(Mandatory=$true)][string]$DecisionEnvelope,
  [Parameter(Mandatory=$true)][string]$ExecutionJournal,
  [Parameter(Mandatory=$true)][string]$EvidenceRoot
)
$ErrorActionPreference="Stop"
$PSNativeCommandUseErrorActionPreference=$true
if($PSVersionTable.PSVersion.Major -lt 7){throw "POWERSHELL_7_REQUIRED"}

$Root=(Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$ExactDecision="APPROVE HAIOS_DESKTOP_CONTROL_PLANE_R1_M11_ACTIVE_CANARY_ACTIVATION"
$M10FinalTerminal="HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_STAGED_READ_ONLY_CUTOVER_QUALIFIED"
$CanaryRoot="C:\Workspace\haios-operator-canary"
$DeploymentRoot="C:\Workspace\haios-desktop-control-m11-runtime"
$StateRoot=Join-Path $env:LOCALAPPDATA "HAIOS\M11"
$M10ApiKeyFile=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "HAIOS\M10\operator-api-key"))
$M10Task="HAIOS-M10-Operator-ReadOnly"
$M11Task="HAIOS-M11-Operator-Active-Canary"
$M10RuntimeRoot="C:\Workspace\haios-desktop-control-runtime"
$M10Supervisor="run-m10-readonly-supervisor.mjs"
$DedicatedTunnel="haios-operator-dedicated-tunnel-client"
$SharedTunnel="haios-tunnel-client"
$ExpectedTunnelRoute="host.docker.internal:8769/mcp"
$SecurePort=8768
function Get-Sha256([string]$Path){(Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()}
function Write-JsonNoBom([string]$Path,$Object){[IO.File]::WriteAllText($Path,(($Object|ConvertTo-Json -Depth 12)+"`n"),[Text.UTF8Encoding]::new($false))}
function Get-ListenerIdentity([int]$PortNumber){
  @((Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue |
    Sort-Object LocalAddress,OwningProcess | ForEach-Object {"$($_.LocalAddress)|$($_.LocalPort)|$($_.OwningProcess)"}))
}
function Get-ContainerDigest([string]$Name){
  $raw=& docker.exe inspect $Name 2>$null
  if($LASTEXITCODE -ne 0 -or -not $raw){throw "M11_ROLLBACK_CONTAINER_UNAVAILABLE:$Name"}
  $bytes=[Text.Encoding]::UTF8.GetBytes(($raw -join "`n"))
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
function Block([string]$Why){throw "M11_ROLLBACK_CURRENTNESS_BLOCKED:$Why"}

$DecisionEnvelope=[IO.Path]::GetFullPath($DecisionEnvelope)
$ExecutionJournal=[IO.Path]::GetFullPath($ExecutionJournal)
$EvidenceRoot=[IO.Path]::GetFullPath($EvidenceRoot)
if(-not(Test-Path -LiteralPath $DecisionEnvelope)){Block "DECISION_MISSING"}
if(-not(Test-Path -LiteralPath $ExecutionJournal)){Block "JOURNAL_MISSING"}
$Envelope=Get-Content -Raw -LiteralPath $DecisionEnvelope | ConvertFrom-Json
if([string]$Envelope.required_human_decision -ne $ExactDecision){Block "DECISION_MISMATCH"}
if([string]$Envelope.m10_final_terminal -ne $M10FinalTerminal){Block "M10_FINAL_TERMINAL_MISMATCH"}
if([string]$Envelope.canary_root -ne $CanaryRoot){Block "CANARY_ROOT_MISMATCH"}
if([string]$Envelope.m10_task_name -ne $M10Task -or [string]$Envelope.m11_task_name -ne $M11Task){Block "TASK_IDENTITY_MISMATCH"}
if(-not(Test-Path -LiteralPath $M10ApiKeyFile)){Block "M10_API_KEY_MISSING"}
if((Get-Sha256 $M10ApiKeyFile) -ne [string]$Envelope.m10_api_key_sha256){Block "M10_API_KEY_DRIFT"}
$journalText=Get-Content -Raw -LiteralPath $ExecutionJournal
if(-not $journalText.Contains("M11_HUMAN_AUTHORITY_ACCEPTED")){Block "AUTHORITY_JOURNAL_MISSING"}
if(-not $journalText.Contains("M11_MUTATION_BEGIN")){Block "MUTATION_JOURNAL_MISSING"}
New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null

$m11TaskObject=Get-ScheduledTask -TaskName $M11Task -ErrorAction SilentlyContinue
if($m11TaskObject){
  $action=@($m11TaskObject.Actions)[0]
  if(-not([string]$action.Arguments).Contains("run-m11-active-canary-supervisor.mjs")){Block "M11_TASK_IDENTITY_DRIFT"}
  Stop-ScheduledTask -TaskName $M11Task -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $M11Task -Confirm:$false
}

if(Test-Path -LiteralPath $DeploymentRoot){
  & git.exe -C $Root worktree remove --force $DeploymentRoot
  if($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath $DeploymentRoot)){Block "M11_DEPLOYMENT_REMOVE_FAILED"}
}
if(Test-Path -LiteralPath $StateRoot){
  Remove-Item -LiteralPath $StateRoot -Recurse -Force
  if(Test-Path -LiteralPath $StateRoot){Block "M11_STATE_REMOVE_FAILED"}
}
$m10TaskObject=Get-ScheduledTask -TaskName $M10Task -ErrorAction SilentlyContinue
if(-not $m10TaskObject){Block "M10_TASK_MISSING"}
$m10Action=@($m10TaskObject.Actions)[0]
if([string]$m10Action.Execute -ne [string]$Envelope.m10_task_execute -or [string]$m10Action.Arguments -ne [string]$Envelope.m10_task_arguments){Block "M10_TASK_ACTION_DRIFT"}
if(-not([string]$m10Action.Arguments).Contains($M10Supervisor)){Block "M10_SUPERVISOR_IDENTITY_DRIFT"}
Start-ScheduledTask -TaskName $M10Task

$m10Probe=Join-Path $M10RuntimeRoot "scripts\probe-m10-readonly-host.mjs"
$m10Proof=Join-Path $EvidenceRoot "m10-readonly-rollback-proof.json"
$deadline=[DateTime]::UtcNow.AddSeconds(45)
$restored=$false
do{
  Start-Sleep -Milliseconds 500
  & "C:\Program Files\nodejs\node.exe" $m10Probe $M10ApiKeyFile $m10Proof *> $null
  if($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $m10Proof)){$restored=$true;break}
}while([DateTime]::UtcNow -lt $deadline)
if(-not $restored){Block "M10_READ_ONLY_EMERGENCY_RESTORE_FAILED"}
$ExpectedRestoredMode="READ_ONLY_EMERGENCY"

if((Get-ContainerDigest $DedicatedTunnel) -ne [string]$Envelope.dedicated_tunnel_sha256){Block "DEDICATED_TUNNEL_DRIFT"}
if((Get-ContainerDigest $SharedTunnel) -ne [string]$Envelope.shared_tunnel_sha256){Block "SHARED_TUNNEL_DRIFT"}
$dedicated=(& docker.exe inspect $DedicatedTunnel | ConvertFrom-Json)[0]
if(-not((@($dedicated.Args)-join ' ').Contains($ExpectedTunnelRoute))){Block "DEDICATED_ROUTE_DRIFT"}
if((@(Get-ListenerIdentity $SecurePort)-join ',') -ne (@($Envelope.listener_8768)-join ',')){Block "SECURE_8768_DRIFT"}
$result=[ordered]@{
  terminal="HAIOS_DESKTOP_CONTROL_PLANE_R1_M11_ROLLED_BACK_TO_CERTIFIED_M10_READ_ONLY_STATE"
  m10_task=$M10Task
  m10_mode=$ExpectedRestoredMode
  m10_api_key_rotated=$false
  canary_root=$CanaryRoot
  canary_head=[string]$Envelope.canary_head
  tunnel_route=$ExpectedTunnelRoute
  listener_8768=@(Get-ListenerIdentity $SecurePort)
}
Write-JsonNoBom (Join-Path $EvidenceRoot "m11-rollback-result.json") $result
[IO.File]::AppendAllText($ExecutionJournal,((([ordered]@{utc=[DateTime]::UtcNow.ToString('o');event="M11_ROLLBACK_M10_RESTORED"})|ConvertTo-Json -Compress)+"`n"),[Text.UTF8Encoding]::new($false))
Write-Host "M11_ROLLBACK_M10_RESTORED"
Write-Host "HAIOS_DESKTOP_CONTROL_PLANE_R1_M11_ROLLED_BACK_TO_CERTIFIED_M10_READ_ONLY_STATE"
