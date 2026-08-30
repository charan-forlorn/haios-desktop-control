[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet("SKILL_FABRIC", "HERMES_OS")][string]$Stage,
  [Parameter(Mandatory = $true)][string]$CandidateManifestSha256,
  [string]$EvidencePath,
  [string]$CertificationPath,
  [string]$StageOneCertificationPath
)
$ErrorActionPreference = "Stop"

# Evidence is live-orchestrator output. This source lane never manufactures PASS text or a tool transcript.
if($Stage -eq "SKILL_FABRIC"){
  if([string]::IsNullOrWhiteSpace($EvidencePath) -or [string]::IsNullOrWhiteSpace($CertificationPath)){ throw "B6_STAGE_ONE_CERTIFICATION_REQUIRED" }
  & (Join-Path $PSScriptRoot "preflight-b6-project-expansion.ps1") -Stage $Stage -CandidateManifestSha256 $CandidateManifestSha256 -EvidencePath $EvidencePath -CertificationPath $CertificationPath | Out-Null
  Write-Output "B6_STAGE_ONE_CERTIFICATION_CURRENT"
  return
}

if([string]::IsNullOrWhiteSpace($StageOneCertificationPath)){ throw "B6_STAGE_ONE_CERTIFICATION_REQUIRED" }
& (Join-Path $PSScriptRoot "preflight-b6-project-expansion.ps1") -Stage $Stage -CandidateManifestSha256 $CandidateManifestSha256 -StageOneCertificationPath $StageOneCertificationPath | Out-Null
Write-Output "B6_STAGE_TWO_PREFLIGHT_CURRENT"
