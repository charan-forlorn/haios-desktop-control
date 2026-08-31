param(
  [Parameter(Mandatory=$true)][string]$DecisionEnvelope,
  [Parameter(Mandatory=$true)][string]$ExecutionJournal,
  [Parameter(Mandatory=$true)][string]$EvidenceRoot
)
$ErrorActionPreference="Stop";$PSNativeCommandUseErrorActionPreference=$true
if($PSVersionTable.PSVersion.Major -lt 7){throw "POWERSHELL_7_REQUIRED"}
$Root=(Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$ExactDecision="APPROVE HAIOS_DESKTOP_CONTROL_PLANE_R1_M12_B5_CANARY_STABILITY_ACTIVATION"
$M11FinalTerminal="HAIOS_DESKTOP_CONTROL_PLANE_R1_M11_ACTIVE_CANARY_QUALIFIED"
$M11FinalCertification="C:\Workspace\haios-desktop-control-m11\evidence\m11\final\m11-final-certification.json"
$M11CertifiedHead="1c32ba789ce89872b36bfed5f7a527b917072d6b";$M11CertifiedManifest="ad2086df0f8bf6993fbe3756084d826d07b2f58b632d6ab49c1491210640815a"
$CanaryRoot="C:\Workspace\haios-operator-canary";$ExpectedCanaryBranch="main"
$M11RuntimeRoot="C:\Workspace\haios-desktop-control-m11-runtime";$DeploymentRoot="C:\Workspace\haios-desktop-control-m12-runtime"
$StateRoot=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "HAIOS\M12"));$M10ApiKeyFile=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "HAIOS\M10\operator-api-key"))
$M11Task="HAIOS-M11-Operator-Active-Canary";$M12Task="HAIOS-M12-Operator-B5-Canary-Stability"
$DedicatedTunnel="haios-operator-dedicated-tunnel-client";$SharedTunnel="haios-tunnel-client";$ExpectedTunnelRoute="host.docker.internal:8769/mcp";$SecurePort=8768
$StateVerifier=Join-Path $Root "scripts\verify-m12-preserved-state.mjs"
function Get-Sha256([string]$Path){(Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()}
function Get-ManifestDigest([string]$RepoRoot){$paths=[string[]]@(& git.exe -C $RepoRoot ls-files);if($LASTEXITCODE -ne 0){throw "M12_ROLLBACK_MANIFEST_ENUM_FAILED"};[Array]::Sort($paths,[StringComparer]::Ordinal);$lines=foreach($rel in $paths){"$(Get-Sha256 (Join-Path $RepoRoot $rel))  $($rel.Replace('\','/'))"};$bytes=[Text.Encoding]::UTF8.GetBytes((($lines -join "`n")+"`n"));[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()}
function Write-JsonNoBom([string]$Path,$Object){[IO.File]::WriteAllText($Path,(($Object|ConvertTo-Json -Depth 12)+"`n"),[Text.UTF8Encoding]::new($false))}
function Get-ListenerIdentity([int]$PortNumber){@((Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue|Sort-Object LocalAddress,OwningProcess|ForEach-Object{"$($_.LocalAddress)|$($_.LocalPort)|$($_.OwningProcess)"}))}
function Get-ContainerDigest([string]$Name){$raw=& docker.exe inspect $Name 2>$null;if($LASTEXITCODE -ne 0 -or -not $raw){throw "M12_ROLLBACK_CONTAINER_UNAVAILABLE:$Name"};$o=($raw|ConvertFrom-Json)[0];$net=@($o.NetworkSettings.Networks.PSObject.Properties|Sort-Object Name|ForEach-Object{[ordered]@{name=$_.Name;network_id=$_.Value.NetworkID;endpoint_id=$_.Value.EndpointID;ip=$_.Value.IPAddress;gateway=$_.Value.Gateway}});$mount=@($o.Mounts|Sort-Object Destination,Type|ForEach-Object{[ordered]@{type=$_.Type;destination=$_.Destination;mode=$_.Mode;rw=$_.RW;propagation=$_.Propagation}});$snap=[ordered]@{id=$o.Id;created=$o.Created;image_id=$o.Image;config_image=$o.Config.Image;path=$o.Path;args=@($o.Args);network_mode=$o.HostConfig.NetworkMode;restart_policy=$o.HostConfig.RestartPolicy;mounts=$mount;networks=$net};$bytes=[Text.Encoding]::UTF8.GetBytes(($snap|ConvertTo-Json -Depth 8 -Compress));[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()}
function Block([string]$Why){throw "M12_ROLLBACK_CURRENTNESS_BLOCKED:$Why"}
$DecisionEnvelope=[IO.Path]::GetFullPath($DecisionEnvelope);$ExecutionJournal=[IO.Path]::GetFullPath($ExecutionJournal);$EvidenceRoot=[IO.Path]::GetFullPath($EvidenceRoot)
if(-not(Test-Path -LiteralPath $DecisionEnvelope)){Block "DECISION_MISSING"};if(-not(Test-Path -LiteralPath $ExecutionJournal)){Block "JOURNAL_MISSING"}
$Envelope=Get-Content -Raw -LiteralPath $DecisionEnvelope|ConvertFrom-Json
if([string]$Envelope.required_human_decision -ne $ExactDecision){Block "DECISION_MISMATCH"};if([string]$Envelope.m11_final_terminal -ne $M11FinalTerminal){Block "M11_FINAL_TERMINAL_MISMATCH"};if([IO.Path]::GetFullPath([string]$Envelope.m11_final_cert_path) -ne $M11FinalCertification){Block "M11_FINAL_CERT_PATH_MISMATCH"};if([string]$Envelope.m11_certified_head -ne $M11CertifiedHead -or [string]$Envelope.m11_certified_manifest_sha256 -ne $M11CertifiedManifest){Block "M11_CERTIFIED_IDENTITY_MISMATCH"}
if([string]$Envelope.canary_root -ne $CanaryRoot -or [string]$Envelope.canary_branch -ne $ExpectedCanaryBranch){Block "CANARY_IDENTITY_MISMATCH"};if([string]$Envelope.m11_task_name -ne $M11Task -or [string]$Envelope.m12_task_name -ne $M12Task){Block "TASK_IDENTITY_MISMATCH"};if(-not(Test-Path -LiteralPath $M10ApiKeyFile) -or (Get-Sha256 $M10ApiKeyFile) -ne [string]$Envelope.m10_api_key_sha256){Block "M10_API_KEY_DRIFT"}
if(-not(Test-Path -LiteralPath $M11FinalCertification) -or (Get-Sha256 $M11FinalCertification) -ne [string]$Envelope.m11_final_cert_sha256){Block "M11_FINAL_CERT_DRIFT"}
$cert=Get-Content -Raw -LiteralPath $M11FinalCertification|ConvertFrom-Json;if([string]$cert.terminal -ne $M11FinalTerminal -or [string]$cert.candidate_head -ne $M11CertifiedHead -or [string]$cert.candidate_manifest_sha256 -ne $M11CertifiedManifest){Block "M11_FINAL_CERT_NOT_CURRENT"}
if(-not(Test-Path -LiteralPath $M11RuntimeRoot -PathType Container)){Block "M11_RUNTIME_MISSING"};$m11RuntimeHead=(& git.exe -C $M11RuntimeRoot rev-parse HEAD).Trim();if($LASTEXITCODE -ne 0 -or $m11RuntimeHead -ne $M11CertifiedHead -or $m11RuntimeHead -ne [string]$Envelope.m11_runtime_head){Block "M11_RUNTIME_HEAD_DRIFT"}
if((& git.exe -C $M11RuntimeRoot status --porcelain).Length -ne 0){Block "M11_RUNTIME_DIRTY"};$m11RuntimeManifest=Get-ManifestDigest $M11RuntimeRoot;if($m11RuntimeManifest -ne $M11CertifiedManifest -or $m11RuntimeManifest -ne [string]$Envelope.m11_runtime_manifest_sha256){Block "M11_RUNTIME_MANIFEST_DRIFT"}
$journalText=Get-Content -Raw -LiteralPath $ExecutionJournal;if(-not $journalText.Contains("M12_HUMAN_AUTHORITY_ACCEPTED")){Block "AUTHORITY_JOURNAL_MISSING"};if(-not $journalText.Contains("M12_MUTATION_BEGIN")){Block "MUTATION_JOURNAL_MISSING"}
New-Item -ItemType Directory -Force -Path $EvidenceRoot|Out-Null
$m12TaskObject=Get-ScheduledTask -TaskName $M12Task -ErrorAction SilentlyContinue
if($m12TaskObject){$m12Action=@($m12TaskObject.Actions)[0];if(-not([string]$m12Action.Arguments).Contains("run-m12-active-canary-supervisor.mjs")){Block "M12_TASK_IDENTITY_DRIFT"};Stop-ScheduledTask -TaskName $M12Task -ErrorAction SilentlyContinue}
# Recovery-first: certified M11 is restored and proven before M12 deployment/state cleanup.
$m11TaskObject=Get-ScheduledTask -TaskName $M11Task -ErrorAction SilentlyContinue;if(-not $m11TaskObject){Block "M11_TASK_MISSING"};$m11Action=@($m11TaskObject.Actions)[0];if([string]$m11Action.Execute -ne [string]$Envelope.m11_task_execute -or [string]$m11Action.Arguments -ne [string]$Envelope.m11_task_arguments){Block "M11_TASK_ACTION_DRIFT"};if(-not([string]$m11Action.Arguments).Contains("run-m11-active-canary-supervisor.mjs")){Block "M11_SUPERVISOR_IDENTITY_DRIFT"}
if(-not(Test-Path -LiteralPath $M11RuntimeRoot -PathType Container)){Block "M11_RUNTIME_MISSING"}
Start-ScheduledTask -TaskName $M11Task
$m11Probe=Join-Path $M11RuntimeRoot "scripts\probe-m11-active-canary-host.mjs";$m11Proof=Join-Path $EvidenceRoot "m11-active-rollback-proof.json";$deadline=[DateTime]::UtcNow.AddSeconds(45);$restored=$false
do{Start-Sleep -Milliseconds 500;$oldNativeErrorPreference=$PSNativeCommandUseErrorActionPreference;$PSNativeCommandUseErrorActionPreference=$false;try{& "C:\Program Files\nodejs\node.exe" $m11Probe $M10ApiKeyFile $m11Proof *> $null;$probeExit=$LASTEXITCODE}finally{$PSNativeCommandUseErrorActionPreference=$oldNativeErrorPreference};if($probeExit -eq 0 -and (Test-Path -LiteralPath $m11Proof)){$restored=$true;break}}while([DateTime]::UtcNow -lt $deadline)
if(-not $restored){Block "M11_ACTIVE_RESTORE_FAILED"}
$canaryBranch=(& git.exe -C $CanaryRoot branch --show-current).Trim();$canaryHead=(& git.exe -C $CanaryRoot rev-parse HEAD).Trim();$canaryStatus=(& git.exe -C $CanaryRoot status --porcelain);if($LASTEXITCODE -ne 0 -or $canaryBranch -ne $ExpectedCanaryBranch -or $canaryBranch -ne [string]$Envelope.canary_branch -or $canaryHead -ne [string]$Envelope.canary_head -or $canaryStatus.Length -ne 0){Block "M12_ROLLBACK_CANARY_PREIMAGE_DRIFT"}
if(-not(Test-Path -LiteralPath $StateVerifier) -or (Get-Sha256 $StateVerifier) -ne [string]$Envelope.state_verifier_sha256){Block "M12_STATE_RECONCILIATION_REQUIRED"}
$preimageStatus=[string]$Envelope.preserved_state_status
$oldNativeErrorPreference=$PSNativeCommandUseErrorActionPreference;$PSNativeCommandUseErrorActionPreference=$false
try{
  if($preimageStatus -eq "ABSENT"){$stateRaw=& "C:\Program Files\nodejs\node.exe" $StateVerifier --activation-partial 2>$null}
  elseif($preimageStatus -eq "VERIFIED_PRESERVED"){$stateRaw=& "C:\Program Files\nodejs\node.exe" $StateVerifier 2>$null}
  else{Block "M12_STATE_RECONCILIATION_REQUIRED"}
  $stateExit=$LASTEXITCODE
}finally{$PSNativeCommandUseErrorActionPreference=$oldNativeErrorPreference}
if($stateExit -ne 0 -or -not $stateRaw){Block "M12_STATE_RECONCILIATION_REQUIRED"};$stateProof=($stateRaw -join "`n")|ConvertFrom-Json
if($preimageStatus -eq "ABSENT"){
  if([string]$stateProof.status -notin @("ABSENT","ACTIVATION_OWNED_PARTIAL") -or $stateProof.cleanupSafe -ne $true){Block "M12_PARTIAL_STATE_OWNERSHIP_REQUIRED"}
} elseif($preimageStatus -eq "VERIFIED_PRESERVED") {
  if([string]$stateProof.status -ne "VERIFIED_PRESERVED"){Block "M12_STATE_RECONCILIATION_REQUIRED"}
} else {Block "M12_STATE_RECONCILIATION_REQUIRED"}
$m12TaskObject=Get-ScheduledTask -TaskName $M12Task -ErrorAction SilentlyContinue;if($m12TaskObject){Unregister-ScheduledTask -TaskName $M12Task -Confirm:$false}
if(Test-Path -LiteralPath $DeploymentRoot){& git.exe -C $Root worktree remove --force $DeploymentRoot;if($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath $DeploymentRoot)){Block "M12_DEPLOYMENT_REMOVE_FAILED"}}
if($preimageStatus -eq "ABSENT"){
  if(Test-Path -LiteralPath $StateRoot){
    $configPath=Join-Path $StateRoot "host-config.json";if(Test-Path -LiteralPath $configPath){Remove-Item -LiteralPath $configPath -Force}
    foreach($name in @("worktrees","leases","transaction-recovery","remediation")){$path=Join-Path $StateRoot $name;if(Test-Path -LiteralPath $path){if(@(Get-ChildItem -LiteralPath $path -Force).Count -ne 0){Block "M12_PARTIAL_STATE_OWNERSHIP_REQUIRED"};Remove-Item -LiteralPath $path}}
    if(@(Get-ChildItem -LiteralPath $StateRoot -Force).Count -ne 0){Block "M12_PARTIAL_STATE_OWNERSHIP_REQUIRED"};Remove-Item -LiteralPath $StateRoot
  }
  Write-Host "M12_PARTIAL_STATE_CLEANUP_COMPLETE";$m12StatePreserved=$false
  $oldNativeErrorPreference=$PSNativeCommandUseErrorActionPreference;$PSNativeCommandUseErrorActionPreference=$false
  try{$stateRaw=& "C:\Program Files\nodejs\node.exe" $StateVerifier 2>$null;$stateExit=$LASTEXITCODE}finally{$PSNativeCommandUseErrorActionPreference=$oldNativeErrorPreference}
  if($stateExit -ne 0 -or -not $stateRaw){Block "M12_STATE_RECONCILIATION_REQUIRED"};$stateProof=($stateRaw -join "`n")|ConvertFrom-Json
  if([string]$stateProof.status -ne "ABSENT"){Block "M12_STATE_RECONCILIATION_REQUIRED"}
} else {
  Write-Host "M12_PRESERVED_STATE_RETAINED";$m12StatePreserved=$true
}
if((Get-ContainerDigest $DedicatedTunnel) -ne [string]$Envelope.dedicated_tunnel_sha256 -or (Get-ContainerDigest $SharedTunnel) -ne [string]$Envelope.shared_tunnel_sha256){Block "TUNNEL_DIGEST_DRIFT"};$dedicated=(& docker.exe inspect $DedicatedTunnel|ConvertFrom-Json)[0];if(-not((@($dedicated.Args)-join ' ').Contains($ExpectedTunnelRoute))){Block "DEDICATED_ROUTE_DRIFT"};if((@(Get-ListenerIdentity $SecurePort)-join ',') -ne (@($Envelope.listener_8768)-join ',')){Block "SECURE_8768_DRIFT"}
$result=[ordered]@{terminal="HAIOS_DESKTOP_CONTROL_PLANE_R1_M12_ROLLED_BACK_TO_CERTIFIED_M11_ACTIVE_CANARY";m11_task=$M11Task;m11_mode="ACTIVE";m10_api_key_rotated=$false;canary_root=$CanaryRoot;canary_head=[string]$Envelope.canary_head;tunnel_route=$ExpectedTunnelRoute;listener_8768=@(Get-ListenerIdentity $SecurePort);m12_state_preserved=$m12StatePreserved;preserved_state_status=[string]$stateProof.status;preserved_state_digest=[string]$stateProof.digest};Write-JsonNoBom (Join-Path $EvidenceRoot "m12-rollback-result.json") $result
[IO.File]::AppendAllText($ExecutionJournal,((([ordered]@{utc=[DateTime]::UtcNow.ToString('o');event="M12_ROLLBACK_M11_RESTORED"})|ConvertTo-Json -Compress)+"`n"),[Text.UTF8Encoding]::new($false))
Write-Host "M12_ROLLBACK_M11_RESTORED";Write-Host "HAIOS_DESKTOP_CONTROL_PLANE_R1_M12_ROLLED_BACK_TO_CERTIFIED_M11_ACTIVE_CANARY"
