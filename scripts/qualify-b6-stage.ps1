[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet("SKILL_FABRIC", "HERMES_OS")][string]$Stage,
  [Parameter(Mandatory = $true)][string]$CandidateManifestSha256,
  [string]$EvidencePath,
  [string]$CertificationPath,
  [string]$StageOneCertificationPath
)
$ErrorActionPreference = "Stop"
$stage1Terminal="HAIOS_DESKTOP_CONTROL_PLANE_R1_B6_SKILL_FABRIC_ADMISSION_QUALIFIED"
$stage2Terminal="HAIOS_DESKTOP_CONTROL_PLANE_R1_B6_HERMES_OS_ADMISSION_QUALIFIED"
# Evidence is measured by the authenticated live qualifier; this wrapper never manufactures PASS text.
if($Stage -eq "SKILL_FABRIC"){
  if([string]::IsNullOrWhiteSpace($EvidencePath) -or [string]::IsNullOrWhiteSpace($CertificationPath)){ throw "B6_STAGE_ONE_CERTIFICATION_REQUIRED" }
  & (Join-Path $PSScriptRoot "preflight-b6-project-expansion.ps1") -Stage $Stage -CandidateManifestSha256 $CandidateManifestSha256 -EvidencePath $EvidencePath -CertificationPath $CertificationPath | Out-Null
  Write-Output "B6_STAGE_ONE_CERTIFICATION_CURRENT"
  Write-Output $stage1Terminal
  return
}
if([string]::IsNullOrWhiteSpace($StageOneCertificationPath)){ throw "B6_STAGE_ONE_CERTIFICATION_REQUIRED" }
if([string]::IsNullOrWhiteSpace($EvidencePath) -and [string]::IsNullOrWhiteSpace($CertificationPath)){
  & (Join-Path $PSScriptRoot "preflight-b6-project-expansion.ps1") -Stage $Stage -CandidateManifestSha256 $CandidateManifestSha256 -StageOneCertificationPath $StageOneCertificationPath | Out-Null
  Write-Output "B6_STAGE_TWO_PREFLIGHT_CURRENT"
  return
}
if([string]::IsNullOrWhiteSpace($EvidencePath) -or [string]::IsNullOrWhiteSpace($CertificationPath)){ throw "B6_STAGE_TWO_CERTIFICATION_REQUIRED" }
if(-not $CertificationPath.EndsWith("stage2-final-certification.json",[StringComparison]::OrdinalIgnoreCase)){ throw "B6_STAGE_TWO_CERTIFICATION_REQUIRED" }
& (Join-Path $PSScriptRoot "preflight-b6-project-expansion.ps1") -Stage $Stage -CandidateManifestSha256 $CandidateManifestSha256 -EvidencePath $EvidencePath -CertificationPath $CertificationPath -StageOneCertificationPath $StageOneCertificationPath | Out-Null
Write-Output "B6_STAGE_TWO_CERTIFICATION_CURRENT"
Write-Output $stage2Terminal
