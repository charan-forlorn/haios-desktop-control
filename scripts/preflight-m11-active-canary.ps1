param(
  [Parameter(Mandatory=$true)][string]$M10FinalCertification,
  [Parameter(Mandatory=$true)][string]$EvidenceRoot
)
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
if ($PSVersionTable.PSVersion.Major -lt 7) { throw "POWERSHELL_7_REQUIRED" }

$Root = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$EvidenceRoot = [IO.Path]::GetFullPath($EvidenceRoot)
$M10FinalCertification = [IO.Path]::GetFullPath($M10FinalCertification)
$ExactDecision = "APPROVE HAIOS_DESKTOP_CONTROL_PLANE_R1_M11_ACTIVE_CANARY_ACTIVATION"
$M10FinalTerminal = "HAIOS_DESKTOP_CONTROL_PLANE_R1_M10_STAGED_READ_ONLY_CUTOVER_QUALIFIED"
$CanaryRoot = "C:\Workspace\haios-operator-canary"
$M10Task = "HAIOS-M10-Operator-ReadOnly"
$M11Task = "HAIOS-M11-Operator-Active-Canary"
$M10RuntimeRoot = "C:\Workspace\haios-desktop-control-runtime"
$M10ApiKeyFile = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "HAIOS\M10\operator-api-key"))
$DedicatedTunnel = "haios-operator-dedicated-tunnel-client"
$SharedTunnel = "haios-tunnel-client"
$ExpectedTunnelRoute = "host.docker.internal:8769/mcp"
$SecurePort = 8768
function Get-Sha256([string]$Path) {
  (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}
function Write-JsonNoBom([string]$Path, $Object) {
  [IO.File]::WriteAllText($Path,(($Object|ConvertTo-Json -Depth 16)+"`n"),[Text.UTF8Encoding]::new($false))
}
function Get-ManifestDigest([string]$RepoRoot) {
  $paths=[string[]]@(& git.exe -C $RepoRoot ls-files)
  if($LASTEXITCODE -ne 0){throw "M11_MANIFEST_ENUM_FAILED"}
  [Array]::Sort($paths,[StringComparer]::Ordinal)
  $lines=foreach($rel in $paths){"$(Get-Sha256 (Join-Path $RepoRoot $rel))  $($rel.Replace('\','/'))"}
  $bytes=[Text.Encoding]::UTF8.GetBytes((($lines -join "`n")+"`n"))
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
function Get-ListenerIdentity([int]$PortNumber) {
  @((Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue |
    Sort-Object LocalAddress,OwningProcess | ForEach-Object { "$($_.LocalAddress)|$($_.LocalPort)|$($_.OwningProcess)" }))
}
function Get-ContainerDigest([string]$Name) {
  $raw=& docker.exe inspect $Name 2>$null
  if($LASTEXITCODE -ne 0 -or -not $raw){throw "M11_CONTAINER_UNAVAILABLE:$Name"}
  $bytes=[Text.Encoding]::UTF8.GetBytes(($raw -join "`n"))
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
if(-not(Test-Path -LiteralPath $M10FinalCertification)){throw "M11_M10_FINAL_CERT_MISSING"}
$cert=Get-Content -Raw -LiteralPath $M10FinalCertification | ConvertFrom-Json
$certTerminal=if($cert.PSObject.Properties.Name -contains 'terminal'){[string]$cert.terminal}elseif($cert.PSObject.Properties.Name -contains 'TERMINAL'){[string]$cert.TERMINAL}else{''}
if($certTerminal -ne $M10FinalTerminal){throw "M11_M10_FINAL_CERT_NOT_QUALIFIED"}
if(-not(Test-Path -LiteralPath $CanaryRoot -PathType Container)){throw "M11_CANARY_ROOT_MISSING"}
if(-not(Test-Path -LiteralPath $M10ApiKeyFile -PathType Leaf)){throw "M11_M10_API_KEY_MISSING"}
if(-not(Test-Path -LiteralPath $M10RuntimeRoot -PathType Container)){throw "M11_M10_RUNTIME_MISSING"}

$candidateHead=(& git.exe -C $Root rev-parse HEAD).Trim()
if($LASTEXITCODE -ne 0){throw "M11_CANDIDATE_HEAD_READ_FAILED"}
if((& git.exe -C $Root status --porcelain).Length -ne 0){throw "M11_CANDIDATE_WORKTREE_DIRTY"}
$candidateManifest=Get-ManifestDigest $Root
$canaryHead=(& git.exe -C $CanaryRoot rev-parse HEAD).Trim()
if($LASTEXITCODE -ne 0){throw "M11_CANARY_HEAD_READ_FAILED"}
if((& git.exe -C $CanaryRoot status --porcelain).Length -ne 0){throw "M11_CANARY_WORKTREE_DIRTY"}

$m10TaskObject=Get-ScheduledTask -TaskName $M10Task -ErrorAction SilentlyContinue
if(-not $m10TaskObject){throw "M11_M10_TASK_MISSING"}
if([string]$m10TaskObject.State -ne 'Running'){throw "M11_M10_TASK_NOT_RUNNING"}
if(Get-ScheduledTask -TaskName $M11Task -ErrorAction SilentlyContinue){throw "M11_M11_TASK_COLLISION"}
$m10Action=@($m10TaskObject.Actions)[0]
New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null
$m10Probe=Join-Path $M10RuntimeRoot "scripts\probe-m10-readonly-host.mjs"
$m10ProbeResult=Join-Path $EvidenceRoot "m10-readonly-preflight-proof.json"
if(-not(Test-Path -LiteralPath $m10Probe)){throw "M11_M10_PROBE_MISSING"}
& "C:\Program Files\nodejs\node.exe" $m10Probe $M10ApiKeyFile $m10ProbeResult *> $null
if($LASTEXITCODE -ne 0 -or -not(Test-Path -LiteralPath $m10ProbeResult)){throw "M11_M10_RUNTIME_PREIMAGE_INVALID"}

$dedicatedRaw=& docker.exe inspect $DedicatedTunnel 2>$null
if($LASTEXITCODE -ne 0 -or -not $dedicatedRaw){throw "M11_DEDICATED_TUNNEL_MISSING"}
$dedicated=($dedicatedRaw|ConvertFrom-Json)[0]
$dedicatedArgs=(@($dedicated.Args)-join ' ')
if(-not $dedicatedArgs.Contains($ExpectedTunnelRoute)){throw "M11_DEDICATED_ROUTE_DRIFT"}
$sharedRaw=& docker.exe inspect $SharedTunnel 2>$null
if($LASTEXITCODE -ne 0 -or -not $sharedRaw){throw "M11_SHARED_TUNNEL_MISSING"}
$listener8768=@(Get-ListenerIdentity $SecurePort)
$listener8769=@(Get-ListenerIdentity 8769)
if($listener8768.Count -eq 0){throw "M11_SECURE_8768_LISTENER_MISSING"}
if($listener8769.Count -eq 0){throw "M11_OPERATOR_8769_LISTENER_MISSING"}

$execute=Join-Path $Root "scripts\execute-m11-active-canary.ps1"
$rollback=Join-Path $Root "scripts\rollback-m11-active-canary.ps1"
$supervisor=Join-Path $Root "scripts\run-m11-active-canary-supervisor.mjs"
$probe=Join-Path $Root "scripts\probe-m11-active-canary-host.mjs"
foreach($path in @($execute,$rollback,$supervisor,$probe)){if(-not(Test-Path -LiteralPath $path)){throw "M11_ACTIVATION_MEMBER_MISSING:$path"}}
$envelope=[ordered]@{
  environment="PRODUCTION"
  required_human_decision=$ExactDecision
  m10_final_terminal=$M10FinalTerminal
  m10_final_cert_path=$M10FinalCertification
  m10_final_cert_sha256=Get-Sha256 $M10FinalCertification
  candidate_head=$candidateHead
  candidate_manifest_sha256=$candidateManifest
  executor_sha256=Get-Sha256 $execute
  rollback_sha256=Get-Sha256 $rollback
  supervisor_sha256=Get-Sha256 $supervisor
  probe_sha256=Get-Sha256 $probe
  canary_root=$CanaryRoot
  canary_head=$canaryHead
  m10_api_key_sha256=Get-Sha256 $M10ApiKeyFile
  m10_task_name=$M10Task
  m10_task_execute=[string]$m10Action.Execute
  m10_task_arguments=[string]$m10Action.Arguments
  m11_task_name=$M11Task
  listener_8768=$listener8768
  listener_8769=$listener8769
  dedicated_tunnel_name=$DedicatedTunnel
  dedicated_tunnel_sha256=Get-ContainerDigest $DedicatedTunnel
  shared_tunnel_name=$SharedTunnel
  shared_tunnel_sha256=Get-ContainerDigest $SharedTunnel
  tunnel_route=$ExpectedTunnelRoute
  tunnel_mutation_authorized=$false
  m10_api_key_rotation_authorized=$false
}
$envelopePath=Join-Path $EvidenceRoot "m11-activation-decision-envelope.json"
Write-JsonNoBom $envelopePath $envelope
Write-Host "M11_PREFLIGHT=PASS"
Write-Host "REQUIRED_HUMAN_DECISION=$ExactDecision"
Write-Host "M10_FINAL_TERMINAL=$M10FinalTerminal"
Write-Host "DECISION_ENVELOPE=$envelopePath"
