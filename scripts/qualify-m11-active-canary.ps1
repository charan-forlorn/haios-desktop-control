param(
  [Parameter(Mandatory=$true)][string]$EvidenceRoot,
  [int]$DirectPort = 18779
)
$ErrorActionPreference="Stop"
$PSNativeCommandUseErrorActionPreference=$true
if($PSVersionTable.PSVersion.Major -lt 7){throw "POWERSHELL_7_REQUIRED"}
if($DirectPort -lt 1024 -or $DirectPort -gt 65535 -or $DirectPort -in @(8768,8769)){throw "M11_DISPOSABLE_PORT_DENIED"}

$Root=(Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$EvidenceRoot=[IO.Path]::GetFullPath($EvidenceRoot)
$FixtureRoot=Join-Path $Root "runtime\m11-fixture\qualification"
$Helper=Join-Path $Root "scripts\live-m11-disposable-active.mjs"
$ResultPath=Join-Path $EvidenceRoot "m11-disposable-active-result.json"
$RealCanary="C:\Workspace\haios-operator-canary"
$M10Task="HAIOS-M10-Operator-ReadOnly"
$DedicatedTunnel="haios-operator-dedicated-tunnel-client"
$SharedTunnel="haios-tunnel-client"
New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null

if(-not(Test-Path -LiteralPath $RealCanary)){throw "M11_REAL_CANARY_MISSING"}
if(-not(Get-ScheduledTask -TaskName $M10Task -ErrorAction SilentlyContinue)){throw "M11_M10_TASK_MISSING"}
foreach($name in @($DedicatedTunnel,$SharedTunnel)){
  & docker.exe inspect $name *> $null
  if($LASTEXITCODE -ne 0){throw "M11_TUNNEL_MISSING:$name"}
}
Push-Location $Root
try{
  & npm.cmd run build
  if($LASTEXITCODE -ne 0){throw "M11_BUILD_FAILED"}
  & "C:\Program Files\nodejs\node.exe" $Helper $FixtureRoot $ResultPath $DirectPort
  if($LASTEXITCODE -ne 0){throw "M11_DISPOSABLE_HELPER_FAILED"}
}finally{
  Pop-Location
}
if(-not(Test-Path -LiteralPath $ResultPath)){throw "M11_DISPOSABLE_RESULT_MISSING"}
if(Test-Path -LiteralPath $FixtureRoot){throw "M11_DISPOSABLE_FIXTURE_RESIDUE"}
$result=Get-Content -Raw -LiteralPath $ResultPath | ConvertFrom-Json
foreach($field in @(
  "exactToolSurface","activeStatusPassed","canonicalUnchangedBeforePromotion","taskPassed",
  "promotionPassed","rollbackPassed","staleCasDenied","stalePromotionNoMutation",
  "worktreeResidueZero","apiKeyFileRemoved","realCanaryUnchanged","m10TaskUnchanged",
  "listenersUnchanged","tunnelsUnchanged"
)){
  if(-not [bool]$result.$field){throw "M11_DISPOSABLE_RESULT_FAILED:$field"}
}
if([bool]$result.secretPersisted){throw "M11_DISPOSABLE_SECRET_PERSISTENCE"}
Write-Host "M11_DISPOSABLE_ACTIVE_QUALIFICATION_PASS"
Write-Host "RESULT=$ResultPath"
