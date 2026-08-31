param(
  [Parameter(Mandatory=$true)][string]$EvidenceRoot
)
$ErrorActionPreference="Stop"
$PSNativeCommandUseErrorActionPreference=$true
if($PSVersionTable.PSVersion.Major -lt 7){throw "POWERSHELL_7_REQUIRED"}

$Root=(Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$EvidenceRoot=[IO.Path]::GetFullPath($EvidenceRoot)
$ExactDecision="APPROVE HAIOS_DESKTOP_CONTROL_PLANE_R1_M12_B5_CANARY_STABILITY_ACTIVATION"
$M11FinalTerminal="HAIOS_DESKTOP_CONTROL_PLANE_R1_M11_ACTIVE_CANARY_QUALIFIED"
$M11FinalCertification="C:\Workspace\haios-desktop-control-m11\evidence\m11\final\m11-final-certification.json"
$M11CertifiedHead="1c32ba789ce89872b36bfed5f7a527b917072d6b"
$M11CertifiedManifest="ad2086df0f8bf6993fbe3756084d826d07b2f58b632d6ab49c1491210640815a"
$CanaryRoot="C:\Workspace\haios-operator-canary"
$ExpectedCanaryBranch="main"
$M11Task="HAIOS-M11-Operator-Active-Canary"
$M12Task="HAIOS-M12-Operator-B5-Canary-Stability"
$M11RuntimeRoot="C:\Workspace\haios-desktop-control-m11-runtime"
$StateRoot=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "HAIOS\M12"))
$M10ApiKeyFile=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "HAIOS\M10\operator-api-key"))
$DedicatedTunnel="haios-operator-dedicated-tunnel-client"
$SharedTunnel="haios-tunnel-client"
$ExpectedTunnelRoute="host.docker.internal:8769/mcp"
$SecurePort=8768
function Get-Sha256([string]$Path){(Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()}
function Write-JsonNoBom([string]$Path,$Object){[IO.File]::WriteAllText($Path,(($Object|ConvertTo-Json -Depth 16)+"`n"),[Text.UTF8Encoding]::new($false))}
function Get-ManifestDigest([string]$RepoRoot){
  $paths=[string[]]@(& git.exe -C $RepoRoot ls-files)
  if($LASTEXITCODE -ne 0){throw "M12_MANIFEST_ENUM_FAILED"}
  [Array]::Sort($paths,[StringComparer]::Ordinal)
  $lines=foreach($rel in $paths){"$(Get-Sha256 (Join-Path $RepoRoot $rel))  $($rel.Replace('\','/'))"}
  $bytes=[Text.Encoding]::UTF8.GetBytes((($lines -join "`n")+"`n"))
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
function Get-ListenerIdentity([int]$PortNumber){
  @((Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue | Sort-Object LocalAddress,OwningProcess | ForEach-Object{"$($_.LocalAddress)|$($_.LocalPort)|$($_.OwningProcess)"}))
}
function Get-ContainerDigest([string]$Name){
  $raw=& docker.exe inspect $Name 2>$null
  if($LASTEXITCODE -ne 0 -or -not $raw){throw "M12_CONTAINER_UNAVAILABLE:$Name"}
  $o=($raw|ConvertFrom-Json)[0]
  $net=@($o.NetworkSettings.Networks.PSObject.Properties|Sort-Object Name|ForEach-Object{[ordered]@{name=$_.Name;network_id=$_.Value.NetworkID;endpoint_id=$_.Value.EndpointID;ip=$_.Value.IPAddress;gateway=$_.Value.Gateway}})
  $mount=@($o.Mounts|Sort-Object Destination,Type|ForEach-Object{[ordered]@{type=$_.Type;destination=$_.Destination;mode=$_.Mode;rw=$_.RW;propagation=$_.Propagation}})
  $snap=[ordered]@{id=$o.Id;created=$o.Created;image_id=$o.Image;config_image=$o.Config.Image;path=$o.Path;args=@($o.Args);network_mode=$o.HostConfig.NetworkMode;restart_policy=$o.HostConfig.RestartPolicy;mounts=$mount;networks=$net}
  $bytes=[Text.Encoding]::UTF8.GetBytes(($snap|ConvertTo-Json -Depth 8 -Compress))
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
if(-not(Test-Path -LiteralPath $M11FinalCertification)){throw "M12_M11_FINAL_CERT_MISSING"}
$cert=Get-Content -Raw -LiteralPath $M11FinalCertification|ConvertFrom-Json
if([string]$cert.terminal -ne $M11FinalTerminal){throw "M12_M11_FINAL_CERT_NOT_QUALIFIED"}
if([string]$cert.candidate_head -ne $M11CertifiedHead){throw "M12_M11_FINAL_CERT_HEAD_MISMATCH"}
if([string]$cert.candidate_manifest_sha256 -ne $M11CertifiedManifest){throw "M12_M11_FINAL_CERT_MANIFEST_MISMATCH"}
if(-not(Test-Path -LiteralPath $CanaryRoot -PathType Container)){throw "M12_CANARY_ROOT_MISSING"}
if(-not(Test-Path -LiteralPath $M10ApiKeyFile -PathType Leaf)){throw "M12_M10_API_KEY_MISSING"}
if(-not(Test-Path -LiteralPath $M11RuntimeRoot -PathType Container)){throw "M12_M11_RUNTIME_MISSING"}
$candidateHead=(& git.exe -C $Root rev-parse HEAD).Trim()
if($LASTEXITCODE -ne 0){throw "M12_CANDIDATE_HEAD_READ_FAILED"}
if((& git.exe -C $Root status --porcelain).Length -ne 0){throw "M12_CANDIDATE_WORKTREE_DIRTY"}
$candidateManifest=Get-ManifestDigest $Root
$m11RuntimeHead=(& git.exe -C $M11RuntimeRoot rev-parse HEAD).Trim()
if($LASTEXITCODE -ne 0 -or $m11RuntimeHead -ne $M11CertifiedHead){throw "M12_M11_RUNTIME_HEAD_DRIFT"}
if((& git.exe -C $M11RuntimeRoot status --porcelain).Length -ne 0){throw "M12_M11_RUNTIME_DIRTY"}
$m11RuntimeManifest=Get-ManifestDigest $M11RuntimeRoot
if($m11RuntimeManifest -ne $M11CertifiedManifest){throw "M12_M11_RUNTIME_MANIFEST_DRIFT"}
$canaryBranch=(& git.exe -C $CanaryRoot branch --show-current).Trim()
if($LASTEXITCODE -ne 0 -or $canaryBranch -ne $ExpectedCanaryBranch){throw "M12_CANARY_BRANCH_DENIED"}
$canaryHead=(& git.exe -C $CanaryRoot rev-parse HEAD).Trim()
if($LASTEXITCODE -ne 0){throw "M12_CANARY_HEAD_READ_FAILED"}
if((& git.exe -C $CanaryRoot status --porcelain).Length -ne 0){throw "M12_CANARY_WORKTREE_DIRTY"}
$m11TaskObject=Get-ScheduledTask -TaskName $M11Task -ErrorAction SilentlyContinue
if(-not $m11TaskObject){throw "M12_M11_TASK_MISSING"}
if([string]$m11TaskObject.State -ne 'Running'){throw "M12_M11_TASK_NOT_RUNNING"}
if(Get-ScheduledTask -TaskName $M12Task -ErrorAction SilentlyContinue){throw "M12_TASK_COLLISION"}
$m11Action=@($m11TaskObject.Actions)[0]
if(-not([string]$m11Action.Arguments).Contains("run-m11-active-canary-supervisor.mjs")){throw "M12_M11_TASK_IDENTITY_DRIFT"}
New-Item -ItemType Directory -Force -Path $EvidenceRoot|Out-Null
$m11Probe=Join-Path $M11RuntimeRoot "scripts\probe-m11-active-canary-host.mjs"
$m11Proof=Join-Path $EvidenceRoot "m11-active-preflight-proof.json"
if(-not(Test-Path -LiteralPath $m11Probe)){throw "M12_M11_PROBE_MISSING"}
& "C:\Program Files\nodejs\node.exe" $m11Probe $M10ApiKeyFile $m11Proof *> $null
if($LASTEXITCODE -ne 0 -or -not(Test-Path -LiteralPath $m11Proof)){throw "M12_M11_RUNTIME_PREIMAGE_INVALID"}
$dedicatedRaw=& docker.exe inspect $DedicatedTunnel 2>$null
if($LASTEXITCODE -ne 0 -or -not $dedicatedRaw){throw "M12_DEDICATED_TUNNEL_MISSING"}
$dedicated=($dedicatedRaw|ConvertFrom-Json)[0]
if(-not((@($dedicated.Args)-join ' ').Contains($ExpectedTunnelRoute))){throw "M12_DEDICATED_ROUTE_DRIFT"}
$sharedRaw=& docker.exe inspect $SharedTunnel 2>$null
if($LASTEXITCODE -ne 0 -or -not $sharedRaw){throw "M12_SHARED_TUNNEL_MISSING"}
$listener8768=@(Get-ListenerIdentity $SecurePort)
$listener8769=@(Get-ListenerIdentity 8769)
if($listener8768.Count -eq 0){throw "M12_SECURE_8768_LISTENER_MISSING"}
if($listener8769.Count -eq 0){throw "M12_OPERATOR_8769_LISTENER_MISSING"}
$execute=Join-Path $Root "scripts\execute-m12-b5-activation.ps1"
$rollback=Join-Path $Root "scripts\rollback-m12-b5-to-m11.ps1"
$supervisor=Join-Path $Root "scripts\run-m12-active-canary-supervisor.mjs"
$probe=Join-Path $Root "scripts\probe-m12-b5-host.mjs"
$stateVerifier=Join-Path $Root "scripts\verify-m12-preserved-state.mjs"
foreach($path in @($execute,$rollback,$supervisor,$probe,$stateVerifier)){if(-not(Test-Path -LiteralPath $path)){throw "M12_ACTIVATION_MEMBER_MISSING:$path"}}
$oldNativeErrorPreference=$PSNativeCommandUseErrorActionPreference;$PSNativeCommandUseErrorActionPreference=$false
try{$stateRaw=& "C:\Program Files\nodejs\node.exe" $stateVerifier 2>$null;$stateExit=$LASTEXITCODE}finally{$PSNativeCommandUseErrorActionPreference=$oldNativeErrorPreference}
if($stateExit -ne 0 -or -not $stateRaw){throw "M12_STATE_RECONCILIATION_REQUIRED"};$stateProof=($stateRaw -join "`n")|ConvertFrom-Json
$envelope=[ordered]@{
  environment="PRODUCTION";required_human_decision=$ExactDecision
  m11_final_terminal=$M11FinalTerminal;m11_final_cert_path=$M11FinalCertification;m11_final_cert_sha256=Get-Sha256 $M11FinalCertification
  m11_certified_head=$M11CertifiedHead;m11_certified_manifest_sha256=$M11CertifiedManifest
  m11_runtime_head=$m11RuntimeHead;m11_runtime_manifest_sha256=$m11RuntimeManifest
  candidate_head=$candidateHead;candidate_manifest_sha256=$candidateManifest
  executor_sha256=Get-Sha256 $execute;rollback_sha256=Get-Sha256 $rollback;supervisor_sha256=Get-Sha256 $supervisor;probe_sha256=Get-Sha256 $probe;state_verifier_sha256=Get-Sha256 $stateVerifier
  preserved_state_status=[string]$stateProof.status;preserved_state_digest=[string]$stateProof.digest
  canary_root=$CanaryRoot;canary_branch=$canaryBranch;canary_head=$canaryHead
  m10_api_key_sha256=Get-Sha256 $M10ApiKeyFile
  m11_task_name=$M11Task;m11_task_execute=[string]$m11Action.Execute;m11_task_arguments=[string]$m11Action.Arguments;m12_task_name=$M12Task
  listener_8768=$listener8768;listener_8769=$listener8769
  dedicated_tunnel_name=$DedicatedTunnel;dedicated_tunnel_sha256=Get-ContainerDigest $DedicatedTunnel
  shared_tunnel_name=$SharedTunnel;shared_tunnel_sha256=Get-ContainerDigest $SharedTunnel;tunnel_route=$ExpectedTunnelRoute
  tunnel_mutation_authorized=$false;m10_api_key_rotation_authorized=$false;s2_authorized=$false;destructive_authorized=$false;generic_exec_authorized=$false;generic_shell_authorized=$false
}
$envelopePath=Join-Path $EvidenceRoot "m12-activation-decision-envelope.json"
Write-JsonNoBom $envelopePath $envelope
Write-Host "M12_PREFLIGHT=PASS"
Write-Host "REQUIRED_HUMAN_DECISION=$ExactDecision"
Write-Host "M11_FINAL_TERMINAL=$M11FinalTerminal"
Write-Host "DECISION_ENVELOPE=$envelopePath"