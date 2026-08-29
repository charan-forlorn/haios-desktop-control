param(
  [Parameter(Mandatory=$true)][string]$DecisionEnvelope,
  [Parameter(Mandatory=$true)][string]$HumanDecision,
  [Parameter(Mandatory=$true)][string]$EvidenceRoot
)
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
if ($PSVersionTable.PSVersion.Major -lt 7) { throw "POWERSHELL_7_REQUIRED" }

$Root=(Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$DecisionEnvelope=[IO.Path]::GetFullPath($DecisionEnvelope)
$EvidenceRoot=[IO.Path]::GetFullPath($EvidenceRoot)
$ExactDecision="APPROVE HAIOS_DESKTOP_CONTROL_PLANE_R1_M11_ACTIVE_CANARY_ACTIVATION"
$M10FinalTerminal="HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_STAGED_READ_ONLY_CUTOVER_QUALIFIED"
$M10FinalCertification="C:\Workspace\haios-desktop-control-m10\evidence\m10\final\m10-final-certification.json"
$M10CertifiedHead="a497bc694e84dcc787f3d85449767e015d86db1a"
$M10CertifiedManifest="a69253eb501f79bfa706d932129dfe7f6b33dae36e760f7737419fc59fba20ea"
$M10RemoteDispatchProof="C:\Workspace\haios-desktop-control-m10\evidence\m10\final\remote-dispatch-proof.json"
$M10RouteDivergenceProof="C:\Workspace\haios-desktop-control-m10\evidence\m10\final\route-divergence-proof.json"
$CanaryRoot="C:\Workspace\haios-operator-canary"
$ExpectedCanaryBranch="main"
$DeploymentRoot="C:\Workspace\haios-desktop-control-m11-runtime"
$StateRoot=Join-Path $env:LOCALAPPDATA "HAIOS\M11"
$M10ApiKeyFile=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "HAIOS\M10\operator-api-key"))
$M10Task="HAIOS-M10-Operator-ReadOnly"
$M11Task="HAIOS-M11-Operator-Active-Canary"
$DedicatedTunnel="haios-operator-dedicated-tunnel-client"
$SharedTunnel="haios-tunnel-client"
$ExpectedTunnelRoute="host.docker.internal:8769/mcp"
$SecurePort=8768
$RollbackScript=Join-Path $Root "scripts\rollback-m11-active-canary.ps1"
$mutationStarted=$false
function Get-Sha256([string]$Path){(Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()}
function Write-JsonNoBom([string]$Path,$Object){[IO.File]::WriteAllText($Path,(($Object|ConvertTo-Json -Depth 16)+"`n"),[Text.UTF8Encoding]::new($false))}
function Get-ManifestDigest([string]$RepoRoot){
  $paths=[string[]]@(& git.exe -C $RepoRoot ls-files)
  if($LASTEXITCODE -ne 0){throw "M11_MANIFEST_ENUM_FAILED"}
  [Array]::Sort($paths,[StringComparer]::Ordinal)
  $lines=foreach($rel in $paths){"$(Get-Sha256 (Join-Path $RepoRoot $rel))  $($rel.Replace('\','/'))"}
  $bytes=[Text.Encoding]::UTF8.GetBytes((($lines -join "`n")+"`n"))
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
function Get-ListenerIdentity([int]$PortNumber){
  @((Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue |
    Sort-Object LocalAddress,OwningProcess | ForEach-Object {"$($_.LocalAddress)|$($_.LocalPort)|$($_.OwningProcess)"}))
}
function Get-ContainerDigest([string]$Name){
  $raw=& docker.exe inspect $Name 2>$null
  if($LASTEXITCODE -ne 0 -or -not $raw){throw "M11_CONTAINER_UNAVAILABLE:$Name"}
  $o=($raw|ConvertFrom-Json)[0]
  $net=@($o.NetworkSettings.Networks.PSObject.Properties|Sort-Object Name|ForEach-Object{[ordered]@{name=$_.Name;network_id=$_.Value.NetworkID;endpoint_id=$_.Value.EndpointID;ip=$_.Value.IPAddress;gateway=$_.Value.Gateway}})
  $mount=@($o.Mounts|Sort-Object Destination,Type|ForEach-Object{[ordered]@{type=$_.Type;destination=$_.Destination;mode=$_.Mode;rw=$_.RW;propagation=$_.Propagation}})
  $snap=[ordered]@{id=$o.Id;created=$o.Created;image_id=$o.Image;config_image=$o.Config.Image;path=$o.Path;args=@($o.Args);network_mode=$o.HostConfig.NetworkMode;restart_policy=$o.HostConfig.RestartPolicy;mounts=$mount;networks=$net}
  $bytes=[Text.Encoding]::UTF8.GetBytes(($snap|ConvertTo-Json -Depth 8 -Compress))
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
function Write-Journal([string]$Event,$Data=$null){
  $record=[ordered]@{utc=[DateTime]::UtcNow.ToString('o');event=$Event}
  if($null -ne $Data){$record.data=$Data}
  [IO.File]::AppendAllText($JournalPath,(($record|ConvertTo-Json -Depth 12 -Compress)+"`n"),[Text.UTF8Encoding]::new($false))
}
function AuthorityFail([string]$Why){throw "M11_ACTIVATION_AUTHORITY_CURRENTNESS_FAILED:$Why"}
if(-not(Test-Path -LiteralPath $DecisionEnvelope)){AuthorityFail "DECISION_ENVELOPE_MISSING"}
$Envelope=Get-Content -Raw -LiteralPath $DecisionEnvelope | ConvertFrom-Json
if([string]$Envelope.required_human_decision -ne $ExactDecision){AuthorityFail "REQUIRED_DECISION_MISMATCH"}
if($HumanDecision -ne $ExactDecision){AuthorityFail "HUMAN_DECISION_MISMATCH"}
if([string]$Envelope.m10_final_terminal -ne $M10FinalTerminal){AuthorityFail "M10_FINAL_TERMINAL_MISMATCH"}
if([string]$Envelope.canary_root -ne $CanaryRoot){AuthorityFail "CANARY_ROOT_MISMATCH"}
if([string]$Envelope.canary_branch -ne $ExpectedCanaryBranch){AuthorityFail "CANARY_BRANCH_MISMATCH"}
if([string]$Envelope.m10_task_name -ne $M10Task -or [string]$Envelope.m11_task_name -ne $M11Task){AuthorityFail "TASK_IDENTITY_MISMATCH"}
if([bool]$Envelope.tunnel_mutation_authorized -or [bool]$Envelope.m10_api_key_rotation_authorized){AuthorityFail "FORBIDDEN_AUTHORITY_PRESENT"}

if([IO.Path]::GetFullPath([string]$Envelope.m10_final_cert_path) -ne $M10FinalCertification){AuthorityFail "M10_FINAL_CERT_PATH_MISMATCH"}
$m10Cert=$M10FinalCertification
if(-not(Test-Path -LiteralPath $m10Cert)){AuthorityFail "M10_FINAL_CERT_MISSING"}
if((Get-Sha256 $m10Cert) -ne [string]$Envelope.m10_final_cert_sha256){AuthorityFail "M10_FINAL_CERT_DRIFT"}
$cert=Get-Content -Raw -LiteralPath $m10Cert | ConvertFrom-Json
$certTerminal=if($cert.PSObject.Properties.Name -contains 'terminal'){[string]$cert.terminal}elseif($cert.PSObject.Properties.Name -contains 'TERMINAL'){[string]$cert.TERMINAL}else{''}
if($certTerminal -ne $M10FinalTerminal){AuthorityFail "M10_FINAL_CERT_NOT_QUALIFIED"}
if([string]$cert.candidate_head -ne $M10CertifiedHead -or [string]$Envelope.m10_certified_head -ne $M10CertifiedHead){AuthorityFail "M10_FINAL_CERT_HEAD_MISMATCH"}
if([string]$cert.candidate_manifest_sha256 -ne $M10CertifiedManifest -or [string]$Envelope.m10_certified_manifest_sha256 -ne $M10CertifiedManifest){AuthorityFail "M10_FINAL_CERT_MANIFEST_MISMATCH"}
if([IO.Path]::GetFullPath([string]$Envelope.remote_dispatch_proof_path) -ne $M10RemoteDispatchProof){AuthorityFail "M10_REMOTE_DISPATCH_PROOF_PATH_MISMATCH"}
if([IO.Path]::GetFullPath([string]$Envelope.route_divergence_proof_path) -ne $M10RouteDivergenceProof){AuthorityFail "M10_ROUTE_DIVERGENCE_PROOF_PATH_MISMATCH"}
if(-not(Test-Path -LiteralPath $M10RemoteDispatchProof) -or -not(Test-Path -LiteralPath $M10RouteDivergenceProof)){AuthorityFail "M10_FINAL_PROOF_MISSING"}
if((Get-Sha256 $M10RemoteDispatchProof) -ne [string]$Envelope.remote_dispatch_proof_sha256 -or (Get-Sha256 $M10RemoteDispatchProof) -ne [string]$cert.remote_dispatch_proof_sha256){AuthorityFail "M10_REMOTE_DISPATCH_PROOF_DRIFT"}
if((Get-Sha256 $M10RouteDivergenceProof) -ne [string]$Envelope.route_divergence_proof_sha256 -or (Get-Sha256 $M10RouteDivergenceProof) -ne [string]$cert.route_divergence_proof_sha256){AuthorityFail "M10_ROUTE_DIVERGENCE_PROOF_DRIFT"}

if((Get-Sha256 $PSCommandPath) -ne [string]$Envelope.executor_sha256){AuthorityFail "EXECUTOR_HASH_DRIFT"}
if((Get-Sha256 $RollbackScript) -ne [string]$Envelope.rollback_sha256){AuthorityFail "ROLLBACK_HASH_DRIFT"}
New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null
$JournalPath=Join-Path $EvidenceRoot "m11-execution-journal.jsonl"
$candidateHead=(& git.exe -C $Root rev-parse HEAD).Trim()
if($LASTEXITCODE -ne 0 -or $candidateHead -ne [string]$Envelope.candidate_head){AuthorityFail "CANDIDATE_HEAD_DRIFT"}
if((& git.exe -C $Root status --porcelain).Length -ne 0){AuthorityFail "CANDIDATE_WORKTREE_DIRTY"}
if((Get-ManifestDigest $Root) -ne [string]$Envelope.candidate_manifest_sha256){AuthorityFail "CANDIDATE_MANIFEST_DRIFT"}
if(-not(Test-Path -LiteralPath $CanaryRoot)){AuthorityFail "CANARY_ROOT_MISSING"}
$canaryBranch=(& git.exe -C $CanaryRoot branch --show-current).Trim()
if($LASTEXITCODE -ne 0 -or $canaryBranch -ne $ExpectedCanaryBranch -or $canaryBranch -ne [string]$Envelope.canary_branch){AuthorityFail "CANARY_BRANCH_DRIFT"}
$canaryHead=(& git.exe -C $CanaryRoot rev-parse HEAD).Trim()
if($LASTEXITCODE -ne 0 -or $canaryHead -ne [string]$Envelope.canary_head){AuthorityFail "CANARY_HEAD_DRIFT"}
if((& git.exe -C $CanaryRoot status --porcelain).Length -ne 0){AuthorityFail "CANARY_WORKTREE_DIRTY"}
if(-not(Test-Path -LiteralPath $M10ApiKeyFile)){AuthorityFail "M10_API_KEY_MISSING"}
if((Get-Sha256 $M10ApiKeyFile) -ne [string]$Envelope.m10_api_key_sha256){AuthorityFail "M10_API_KEY_DRIFT"}

$m10TaskObject=Get-ScheduledTask -TaskName $M10Task -ErrorAction SilentlyContinue
if(-not $m10TaskObject -or [string]$m10TaskObject.State -ne 'Running'){AuthorityFail "M10_TASK_NOT_RUNNING"}
$m10Action=@($m10TaskObject.Actions)[0]
if([string]$m10Action.Execute -ne [string]$Envelope.m10_task_execute -or [string]$m10Action.Arguments -ne [string]$Envelope.m10_task_arguments){AuthorityFail "M10_TASK_ACTION_DRIFT"}
if(Get-ScheduledTask -TaskName $M11Task -ErrorAction SilentlyContinue){AuthorityFail "M11_TASK_COLLISION"}
if(Test-Path -LiteralPath $DeploymentRoot){AuthorityFail "M11_DEPLOYMENT_COLLISION"}
if(Test-Path -LiteralPath $StateRoot){AuthorityFail "M11_STATE_COLLISION"}
$M10RuntimeRoot="C:\Workspace\haios-desktop-control-runtime"
$m10Probe=Join-Path $M10RuntimeRoot "scripts\probe-m10-readonly-host.mjs"
$m10Proof=Join-Path $EvidenceRoot "m10-readonly-authority-proof.json"
if(-not(Test-Path -LiteralPath $m10Probe)){AuthorityFail "M10_PROBE_MISSING"}
& "C:\Program Files\nodejs\node.exe" $m10Probe $M10ApiKeyFile $m10Proof *> $null
if($LASTEXITCODE -ne 0 -or -not(Test-Path -LiteralPath $m10Proof)){AuthorityFail "M10_RUNTIME_PREIMAGE_INVALID"}

$listener8768=@(Get-ListenerIdentity $SecurePort)
$listener8769=@(Get-ListenerIdentity 8769)
if(($listener8768 -join ',') -ne (@($Envelope.listener_8768)-join ',')){AuthorityFail "SECURE_8768_DRIFT"}
if(($listener8769 -join ',') -ne (@($Envelope.listener_8769)-join ',')){AuthorityFail "OPERATOR_8769_DRIFT"}
if((Get-ContainerDigest $DedicatedTunnel) -ne [string]$Envelope.dedicated_tunnel_sha256){AuthorityFail "DEDICATED_TUNNEL_DRIFT"}
if((Get-ContainerDigest $SharedTunnel) -ne [string]$Envelope.shared_tunnel_sha256){AuthorityFail "SHARED_TUNNEL_DRIFT"}
$dedicated=(& docker.exe inspect $DedicatedTunnel | ConvertFrom-Json)[0]
if(-not((@($dedicated.Args)-join ' ').Contains($ExpectedTunnelRoute))){AuthorityFail "DEDICATED_ROUTE_DRIFT"}

Write-Journal "M11_HUMAN_AUTHORITY_ACCEPTED" @{decision_matched=$true}
Write-Journal "M11_M10_FINAL_CERT_CURRENT" @{sha256=[string]$Envelope.m10_final_cert_sha256}
Write-Journal "M11_CANDIDATE_CURRENT" @{candidate_manifest_sha256=[string]$Envelope.candidate_manifest_sha256}
Write-Journal "M11_CANARY_PREIMAGE_CURRENT" @{canary_branch=$canaryBranch;canary_head=$canaryHead}
Write-Journal "M11_M10_API_KEY_CURRENT" @{m10_api_key_sha256=[string]$Envelope.m10_api_key_sha256}
Write-Journal "M11_M10_RUNTIME_PREIMAGE_CURRENT"
Write-Journal "M11_TUNNEL_PREIMAGE_CURRENT" @{route=$ExpectedTunnelRoute;listener_8768=$listener8768}
function Set-M11StateAcl([string]$Path){
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

try{
  Write-Journal "M11_MUTATION_BEGIN"
  $mutationStarted=$true
  & git.exe -C $Root worktree add --detach $DeploymentRoot ([string]$Envelope.candidate_head)
  if($LASTEXITCODE -ne 0){throw "M11_DEPLOYMENT_WORKTREE_CREATE_FAILED"}
  if((Get-ManifestDigest $DeploymentRoot) -ne [string]$Envelope.candidate_manifest_sha256){throw "M11_DEPLOYMENT_MANIFEST_DRIFT"}
  Push-Location $DeploymentRoot
  try{
    & npm.cmd ci --ignore-scripts --no-audit --no-fund; if($LASTEXITCODE -ne 0){throw "M11_DEPLOYMENT_NPM_CI_FAILED"}
    & npm.cmd run build; if($LASTEXITCODE -ne 0){throw "M11_DEPLOYMENT_BUILD_FAILED"}
  }finally{Pop-Location}
  Write-Journal "M11_DEPLOYMENT_READY"
  New-Item -ItemType Directory -Path $StateRoot | Out-Null
  Set-M11StateAcl $StateRoot
  $Worktrees=Join-Path $StateRoot "worktrees"
  New-Item -ItemType Directory -Path $Worktrees | Out-Null
  $ConfigPath=Join-Path $StateRoot "host-config.json"
  $Config=[ordered]@{
    apiKeyFile=$M10ApiKeyFile
    worktreeRoot=$Worktrees
    allowedProjects=[ordered]@{"operator-canary"=$CanaryRoot}
    port=8769
    mode="ACTIVE"
    activationScope="M11_CANARY_ONLY"
  }
  Write-JsonNoBom $ConfigPath $Config
  if((Get-Sha256 $M10ApiKeyFile) -ne [string]$Envelope.m10_api_key_sha256){throw "M11_M10_API_KEY_POSTCONFIG_DRIFT"}
  Write-Journal "M11_STATE_READY"

  Stop-ScheduledTask -TaskName $M10Task
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  while((Get-NetTCPConnection -State Listen -LocalPort 8769 -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 500}
  if(Get-NetTCPConnection -State Listen -LocalPort 8769 -ErrorAction SilentlyContinue){throw "M11_PORT_8769_NOT_RELEASED"}
  Write-Journal "M11_M10_RUNTIME_STOPPED"

  $identityName=[Security.Principal.WindowsIdentity]::GetCurrent().Name
  $node="C:\Program Files\nodejs\node.exe"
  $supervisor=Join-Path $DeploymentRoot "scripts\run-m11-active-canary-supervisor.mjs"
  $action=New-ScheduledTaskAction -Execute $node -Argument "`"$supervisor`" `"$ConfigPath`""
  $trigger=New-ScheduledTaskTrigger -AtLogOn -User $identityName
  $principal=New-ScheduledTaskPrincipal -UserId $identityName -LogonType Interactive -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $task=New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
  Register-ScheduledTask -TaskName $M11Task -InputObject $task | Out-Null
  Start-ScheduledTask -TaskName $M11Task
  Write-Journal "M11_ACTIVE_TASK_STARTED"

  $probe=Join-Path $DeploymentRoot "scripts\probe-m11-active-canary-host.mjs"
  $activeProof=Join-Path $EvidenceRoot "m11-active-host-proof.json"
  $deadline=[DateTime]::UtcNow.AddSeconds(45)
  $activeReady=$false
  do{
    Start-Sleep -Milliseconds 500
    $oldNativeErrorPreference=$PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference=$false
    try{
      & $node $probe $M10ApiKeyFile $activeProof *> $null
      $probeExit=$LASTEXITCODE
    }finally{$PSNativeCommandUseErrorActionPreference=$oldNativeErrorPreference}
    if($probeExit -eq 0 -and (Test-Path -LiteralPath $activeProof)){$activeReady=$true;break}
  }while([DateTime]::UtcNow -lt $deadline)
  if(-not $activeReady){throw "M11_ACTIVE_HOST_MCP_PROOF_FAILED"}
  Write-Journal "M11_ACTIVE_HOST_READY"

  if((Get-ContainerDigest $DedicatedTunnel) -ne [string]$Envelope.dedicated_tunnel_sha256){throw "M11_DEDICATED_TUNNEL_POSTIMAGE_DRIFT"}
  if((Get-ContainerDigest $SharedTunnel) -ne [string]$Envelope.shared_tunnel_sha256){throw "M11_SHARED_TUNNEL_POSTIMAGE_DRIFT"}
  $dedicatedPost=(& docker.exe inspect $DedicatedTunnel | ConvertFrom-Json)[0]
  if(-not((@($dedicatedPost.Args)-join ' ').Contains($ExpectedTunnelRoute))){throw "M11_DEDICATED_ROUTE_POSTIMAGE_DRIFT"}
  if((@(Get-ListenerIdentity $SecurePort)-join ',') -ne (@($Envelope.listener_8768)-join ',')){throw "M11_SECURE_8768_POSTIMAGE_DRIFT"}
  Write-Journal "M11_TUNNEL_POSTIMAGE_CURRENT"
  $result=[ordered]@{
    candidate_head=[string]$Envelope.candidate_head
    mode="ACTIVE"
    activation_scope="M11_CANARY_ONLY"
    canary_root=$CanaryRoot
    canary_branch=$canaryBranch
    canary_head_preimage=[string]$Envelope.canary_head
    m10_api_key_rotated=$false
    tunnel_route_changed=$false
    shared_8768_changed=$false
  }
  Write-JsonNoBom (Join-Path $EvidenceRoot "m11-activation-result.json") $result
  Write-Journal "M11_FORWARD_ACTIVATION_COMPLETE"
  Write-Host "M11_ACTIVE_CANARY_ACTIVATION_FORWARD_COMPLETE"
}catch{
  $forwardError=$_.Exception.Message
  Write-Journal "M11_FORWARD_FAILURE" @{error=$forwardError}
  if($mutationStarted){
    try{
      & pwsh -NoProfile -File $RollbackScript -DecisionEnvelope $DecisionEnvelope -ExecutionJournal $JournalPath -EvidenceRoot $EvidenceRoot
      if($LASTEXITCODE -ne 0){throw "M11_ROLLBACK_EXIT_$LASTEXITCODE"}
      Write-Journal "M11_AUTOMATIC_ROLLBACK_COMPLETE"
    }catch{
      Write-Journal "M11_AUTOMATIC_ROLLBACK_BLOCKED" @{error=$_.Exception.Message}
      throw "M11_FORWARD_FAILED_ROLLBACK_BLOCKED:$forwardError"
    }
  }
  throw "M11_FORWARD_FAILED_ROLLED_BACK:$forwardError"
}
