param(
  [Parameter(Mandatory=$true)][string]$DecisionEnvelope,
  [Parameter(Mandatory=$true)][string]$EvidenceRoot
)
$ErrorActionPreference="Stop"
$PSNativeCommandUseErrorActionPreference=$true
if($PSVersionTable.PSVersion.Major -lt 7){throw "POWERSHELL_7_REQUIRED"}
$Root=(Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$DeploymentRoot="C:\Workspace\haios-desktop-control-runtime"
$StateRoot=Join-Path $env:LOCALAPPDATA "HAIOS\M10"
$TaskName="HAIOS-M10-Operator-ReadOnly"
$SharedTunnel="haios-tunnel-client"
$DedicatedTunnel="haios-operator-dedicated-tunnel-client"
$OldOperator="haios-operator-mcp"
$ExactDecision="APPROVE HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_STAGED_READ_ONLY_CUTOVER"
function Get-Sha256([string]$Path){(Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()}
function Write-JsonNoBom([string]$Path,$Object){[IO.File]::WriteAllText($Path,(($Object|ConvertTo-Json -Depth 14)+"`n"),[Text.UTF8Encoding]::new($false))}
function Get-ListenerIdentity([int]$PortNumber){@((Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue|Sort-Object LocalAddress,OwningProcess|ForEach-Object{"$($_.LocalAddress)|$($_.LocalPort)|$($_.OwningProcess)"}))}
function Get-ContainerIntegrityDigest([string]$Name){
  $raw=& docker.exe inspect $Name 2>$null;if($LASTEXITCODE -ne 0 -or -not $raw){throw "M10_LIVE_CONTAINER_MISSING:$Name"};$o=($raw|ConvertFrom-Json)[0]
  $net=@($o.NetworkSettings.Networks.PSObject.Properties|Sort-Object Name|ForEach-Object{[ordered]@{name=$_.Name;network_id=$_.Value.NetworkID;endpoint_id=$_.Value.EndpointID;ip=$_.Value.IPAddress;gateway=$_.Value.Gateway}})
  $mount=@($o.Mounts|Sort-Object Destination,Type|ForEach-Object{[ordered]@{type=$_.Type;destination=$_.Destination;mode=$_.Mode;rw=$_.RW;propagation=$_.Propagation}})
  $snap=[ordered]@{id=$o.Id;created=$o.Created;image_id=$o.Image;config_image=$o.Config.Image;path=$o.Path;args=@($o.Args);network_mode=$o.HostConfig.NetworkMode;restart_policy=$o.HostConfig.RestartPolicy;mounts=$mount;networks=$net}
  $bytes=[Text.Encoding]::UTF8.GetBytes(($snap|ConvertTo-Json -Depth 8 -Compress));[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
function Get-ManifestDigest([string]$RepoRoot){
  $paths=[string[]]@(& git.exe -C $RepoRoot ls-files);if($LASTEXITCODE -ne 0){throw "M10_LIVE_MANIFEST_ENUM_FAILED"};[Array]::Sort($paths,[StringComparer]::Ordinal)
  $lines=foreach($rel in $paths){"$(Get-Sha256 (Join-Path $RepoRoot $rel))  $($rel.Replace('\','/'))"};$text=($lines -join "`n")+"`n";$bytes=[Text.Encoding]::UTF8.GetBytes($text)
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
function Test-SecretAcl{
  if(-not(Test-Path -LiteralPath $StateRoot)){return $false}
  $acl=Get-Acl -LiteralPath $StateRoot
  $current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $system=[Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::LocalSystemSid,$null).Value
  $admins=[Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid,$null).Value
  $world=[Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::WorldSid,$null).Value
  $users=[Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::BuiltinUsersSid,$null).Value
  $sids=@($acl.Access|ForEach-Object{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value})
  $acl.AreAccessRulesProtected -and ($sids -contains $current) -and ($sids -contains $system) -and ($sids -contains $admins) -and ($sids -notcontains $world) -and ($sids -notcontains $users)
}
$DecisionEnvelope=[IO.Path]::GetFullPath($DecisionEnvelope);$EvidenceRoot=[IO.Path]::GetFullPath($EvidenceRoot)
if(-not(Test-Path -LiteralPath $DecisionEnvelope)){throw "M10_LIVE_DECISION_MISSING"}
New-Item -ItemType Directory -Force -Path $EvidenceRoot|Out-Null
$Envelope=Get-Content -Raw -LiteralPath $DecisionEnvelope|ConvertFrom-Json
if([string]$Envelope.environment -ne "PRODUCTION" -or [string]$Envelope.human_decision -ne $ExactDecision){throw "M10_LIVE_DECISION_INVALID"}
if(-not(Test-Path -LiteralPath $DeploymentRoot)){throw "M10_LIVE_DEPLOYMENT_MISSING"}
$head=(& git.exe -C $DeploymentRoot rev-parse HEAD).Trim();if($head -ne [string]$Envelope.candidate_head){throw "M10_LIVE_DEPLOYMENT_HEAD_DRIFT"}
if((Get-ManifestDigest $DeploymentRoot) -ne [string]$Envelope.candidate_manifest_sha256){throw "M10_LIVE_DEPLOYMENT_MANIFEST_DRIFT"}
try{$health=Invoke-RestMethod -Uri "http://127.0.0.1:8769/healthz" -TimeoutSec 3}catch{throw "M10_LIVE_HOST_HEALTH_FAILED"}
if([string]$health.mode -ne "READ_ONLY_EMERGENCY"){throw "M10_LIVE_HOST_MODE_FAILED"}
$sharedBinding=@($Envelope.container_digests|Where-Object{$_.name -eq $SharedTunnel})[0]
if(-not $sharedBinding -or (Get-ContainerIntegrityDigest $SharedTunnel) -ne [string]$sharedBinding.sha256){throw "M10_LIVE_SHARED_TUNNEL_DRIFT"}
if((@(Get-ListenerIdentity 8768)-join ',') -ne (@($Envelope.listener_8768)-join ',')){throw "M10_LIVE_8768_DRIFT"}
$operatorHealth=(& docker.exe inspect --format '{{.State.Health.Status}}' $OldOperator 2>$null).Trim()
if($LASTEXITCODE -ne 0 -or $operatorHealth -ne 'healthy'){throw "M10_LIVE_OLD_OPERATOR_UNHEALTHY"}
$dedicated=(& docker.exe inspect $DedicatedTunnel|ConvertFrom-Json)[0]
if($LASTEXITCODE -ne 0 -or -not ((@($dedicated.Args)-join ' ').Contains("host.docker.internal:8769/mcp"))){throw "M10_LIVE_DEDICATED_ROUTE_DRIFT"}
$task=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if(-not $task){throw "M10_LIVE_TASK_MISSING"}
$expectedLauncher=Join-Path $DeploymentRoot "scripts\run-m10-readonly-runtime.mjs"
$action=@($task.Actions)[0]
if(-not ([string]$action.Arguments).Contains($expectedLauncher)){throw "M10_LIVE_TASK_IDENTITY_DRIFT"}
$secretAclPass=Test-SecretAcl
if(-not $secretAclPass){throw "M10_LIVE_SECRET_ACL_FAILED"}
$apiKeyFile=Join-Path $StateRoot "operator-api-key";$configPath=Join-Path $StateRoot "host-config.json"
if(-not(Test-Path -LiteralPath $apiKeyFile) -or -not(Test-Path -LiteralPath $configPath)){throw "M10_LIVE_SECRET_OR_CONFIG_MISSING"}

$proofPath=Join-Path $EvidenceRoot "dedicated-route-proof.json"
if(-not(Test-Path -LiteralPath $proofPath)){throw "M10_DEDICATED_ROUTE_PROOF_MISSING"}
$proof=Get-Content -Raw -LiteralPath $proofPath|ConvertFrom-Json
$proofPass=[bool]$proof.exact_13_tools -and [string]$proof.mode -eq "READ_ONLY_EMERGENCY" -and $proof.mutation_active -eq $false -and $proof.s2_enabled -eq $false -and $proof.generic_exec -eq $false -and $proof.generic_shell -eq $false -and [string]$proof.destructive -eq "LOCKED" -and [bool]$proof.mutation_denied
if(-not $proofPass){throw "M10_DEDICATED_ROUTE_PROOF_INVALID"}

$secretPatterns=@('(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{20,}','(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}','(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}','BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY')
$secretLeak=$false
foreach($file in (Get-ChildItem -LiteralPath $EvidenceRoot -File -ErrorAction SilentlyContinue)){
  $text=[IO.File]::ReadAllText($file.FullName)
  foreach($pattern in $secretPatterns){if($text -match $pattern){$secretLeak=$true}}
}
if($secretLeak){throw "M10_LIVE_SECRET_EVIDENCE_LEAK"}
$residue=@(& docker.exe ps -aq --filter 'label=haios.m10.owner=readonly-parity' 2>$null|Where-Object{$_})
if($residue.Count -ne 0){throw "M10_LIVE_DISPOSABLE_CONTAINER_RESIDUE"}
$result=[ordered]@{
  mission="HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_STAGED_READ_ONLY_CUTOVER"
  candidate_head=$head
  candidate_manifest_sha256=[string]$Envelope.candidate_manifest_sha256
  mode="READ_ONLY_EMERGENCY"
  dedicated_route_proof="PASS"
  exact_13_tools=$true
  shared_tunnel_unchanged=$true
  secure_8768_unchanged=$true
  old_operator_internal_healthy=$true
  task_identity_pass=$true
  secret_acl_pass=$true
  secrets_persisted=$false
  disposable_residue=0
  terminal="M10_LIVE_READ_ONLY_QUALIFICATION_PASS"
}
Write-JsonNoBom (Join-Path $EvidenceRoot "m10-live-qualification-result.json") $result
Write-Host "M10_LIVE_READ_ONLY_QUALIFICATION_PASS"
