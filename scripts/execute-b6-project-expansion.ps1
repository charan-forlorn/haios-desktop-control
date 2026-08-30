[CmdletBinding()]
param([Parameter(Mandatory = $true)][ValidateSet("SKILL_FABRIC", "HERMES_OS")][string]$Stage,[Parameter(Mandatory = $true)][string]$CandidateManifestSha256,[string]$EvidencePath,[string]$CertificationPath,[string]$StageOneCertificationPath)
$ErrorActionPreference = "Stop"
# Recovery-first handoff: the live orchestrator supplies deployment mechanics after this exact source candidate is independently qualified.
& (Join-Path $PSScriptRoot "preflight-b6-project-expansion.ps1") -Stage $Stage -CandidateManifestSha256 $CandidateManifestSha256 -EvidencePath $EvidencePath -CertificationPath $CertificationPath -StageOneCertificationPath $StageOneCertificationPath | Out-Null
if($Stage -eq "SKILL_FABRIC"){ Write-Output "B6_ROLLBACK_TARGET_CERTIFIED_M12" }else{ Write-Output "B6_ROLLBACK_TARGET_QUALIFIED_B6_SKILL_FABRIC" }
throw "B6_LIVE_ACTIVATION_ORCHESTRATOR_REQUIRED"
