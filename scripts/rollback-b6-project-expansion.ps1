[CmdletBinding()]
param([Parameter(Mandatory = $true)][ValidateSet("SKILL_FABRIC", "HERMES_OS")][string]$Stage)
$ErrorActionPreference = "Stop"
# This lane deliberately never deletes a state root. VERIFIED_PRESERVED remains intact; unknown or partial state requires orchestration evidence.
if($Stage -eq "SKILL_FABRIC"){ Write-Output "B6_ROLLBACK_RESTORE_CERTIFIED_M12" }else{ Write-Output "B6_ROLLBACK_RESTORE_QUALIFIED_B6_SKILL_FABRIC" }
throw "B6_ROLLBACK_ORCHESTRATOR_REQUIRED"
