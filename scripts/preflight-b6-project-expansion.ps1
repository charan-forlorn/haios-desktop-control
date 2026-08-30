[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet("SKILL_FABRIC", "HERMES_OS")][string]$Stage,
  [Parameter(Mandatory = $true)][string]$CandidateManifestSha256,
  [string]$EvidencePath,
  [string]$CertificationPath,
  [string]$StageOneCertificationPath
)
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$roots = @{ "operator-canary" = "C:\Workspace\haios-operator-canary"; "skill-fabric" = "C:\Workspace\haios-skill-fabric"; "hermes-os" = "C:\Workspace\hermes-ai-operating-system-b6-canonical" }
$stage1Terminal = "HAIOS_DESKTOP_CONTROL_PLANE_R1_B6_SKILL_FABRIC_ADMISSION_QUALIFIED"
$evidenceRoot = Join-Path $env:LOCALAPPDATA "HAIOS\B6\evidence\stage1"
$expectedEvidencePath = Join-Path $evidenceRoot "stage1-live-qualification.json"
$expectedCertificationPath = Join-Path $evidenceRoot "stage1-final-certification.json"
$certificateFields = @("schema","stage","terminal","targetProjectId","b6CandidateHeadSha","b6CandidateTrackedCount","b6CandidateManifestSha256","canonicalPath","gitCommonDirIdentity","targetHeadSha","targetTrackedCount","targetManifestSha256","liveQualificationEvidencePath","liveQualificationEvidenceSha256","liveQualificationResult","exact13Tools","projectAdmitted","hermesOsDenied","canonicalPreHeadSha","canonicalPostHeadSha","canonicalPreStatusClean","canonicalPostStatusClean","ownedResidueCount","effectPolicyVerified","networkAuthority","rollbackRecoveryClassification","createdAt","certificationSha256")
$evidenceFields = @("schema","stage","targetProjectId","result","b6CandidateHeadSha","b6CandidateManifestSha256","skillFabricHeadSha","skillFabricManifestSha256","exact13Tools","projectAdmitted","hermesOsDenied","canonicalPreHeadSha","canonicalPostHeadSha","canonicalPreStatusClean","canonicalPostStatusClean","ownedResidueCount","effectPolicyVerified","networkAuthority","rollbackRecoveryClassification")
function Fail-Current { throw "B6_STAGE_ONE_CERTIFICATION_NOT_CURRENT" }
function Assert-Current([bool]$Condition) { if(-not $Condition){ Fail-Current } }
function Get-Sha256([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }
function Get-BytesSha256([byte[]]$Bytes) { $sha=[Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace("-","").ToLowerInvariant() } finally { $sha.Dispose() } }
function Same-Path([string]$A,[string]$B) { [string]::Equals([IO.Path]::GetFullPath($A).TrimEnd('\'),[IO.Path]::GetFullPath($B).TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase) }
function Resolve-CanonicalPath([string]$Path) {
  if(-not (Test-Path -LiteralPath $Path)){ throw "B6_CANONICAL_PATH_REQUIRED" }
  (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path.TrimEnd('\')
}
function ConvertTo-CanonicalJson($Value) {
  if($null -eq $Value){ return "null" }
  if($Value -is [bool]){ return $Value.ToString().ToLowerInvariant() }
  if($Value -is [string]){ return ($Value | ConvertTo-Json -Compress) }
  if($Value -is [byte] -or $Value -is [int16] -or $Value -is [int32] -or $Value -is [int64] -or $Value -is [uint16] -or $Value -is [uint32] -or $Value -is [uint64] -or $Value -is [decimal] -or $Value -is [double]) { return [Convert]::ToString($Value,[Globalization.CultureInfo]::InvariantCulture) }
  if($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [System.Collections.IDictionary])) { return "[" + (($Value | ForEach-Object { ConvertTo-CanonicalJson $_ }) -join ",") + "]" }
  if($Value -is [System.Collections.IDictionary]) { $names=@($Value.Keys | ForEach-Object {[string]$_} | Sort-Object -CaseSensitive); return "{" + (($names | ForEach-Object { "$($_ | ConvertTo-Json -Compress):$(ConvertTo-CanonicalJson $Value[$_])" }) -join ",") + "}" }
  $names=@($Value.PSObject.Properties.Name | Sort-Object -CaseSensitive)
  "{" + (($names | ForEach-Object { "$($_ | ConvertTo-Json -Compress):$(ConvertTo-CanonicalJson $Value.$_)" }) -join ",") + "}"
}
function Get-CanonicalSha256($Value) { Get-BytesSha256 ([Text.Encoding]::UTF8.GetBytes((ConvertTo-CanonicalJson $Value))) }
function Get-RepositoryFacts([string]$Root) {
  $canonicalPath=Resolve-CanonicalPath $Root
  $head=(@(& git.exe -C $canonicalPath rev-parse --verify HEAD 2>$null) -join "`n").Trim()
  if($LASTEXITCODE -ne 0 -or $head -notmatch "^[a-f0-9]{40,64}$"){ throw "B6_CANONICAL_HEAD_REQUIRED" }
  $commonRaw=(@(& git.exe -C $canonicalPath rev-parse --git-common-dir 2>$null) -join "`n").Trim()
  if($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($commonRaw)){ throw "B6_GIT_COMMON_DIR_REQUIRED" }
  $commonDir=Resolve-CanonicalPath $(if([IO.Path]::IsPathRooted($commonRaw)){$commonRaw}else{Join-Path $canonicalPath $commonRaw})
  $paths=[string[]]@(& git.exe -C $canonicalPath ls-files); if($LASTEXITCODE -ne 0){ throw "B6_PHYSICAL_MANIFEST_REQUIRED" }
  [Array]::Sort($paths,[StringComparer]::Ordinal)
  $lines=[Collections.Generic.List[string]]::new()
  foreach($relativePath in $paths){
    $absolutePath=Join-Path $canonicalPath $relativePath
    if(-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)){ throw "B6_PHYSICAL_MANIFEST_REQUIRED" }
    $lines.Add("$(Get-Sha256 $absolutePath)  $($relativePath.Replace('\','/'))")
  }
  $manifestSha256=Get-BytesSha256 ([Text.Encoding]::UTF8.GetBytes((($lines.ToArray() -join "`n")+"`n")))
  $status=(@(& git.exe -C $canonicalPath status --porcelain=v1 2>$null) -join "`n").Trim()
  if($LASTEXITCODE -ne 0){ throw "B6_CANONICAL_STATUS_REQUIRED" }
  [pscustomobject]@{canonicalPath=$canonicalPath;gitCommonDirIdentity=$commonDir;head=$head;trackedCount=$paths.Count;manifestSha256=$manifestSha256;clean=[string]::IsNullOrWhiteSpace($status)}
}
function Assert-ExactFields($Object,[string[]]$Fields) {
  $actual=@($Object.PSObject.Properties.Name | Sort-Object -CaseSensitive); $expected=@($Fields | Sort-Object -CaseSensitive)
  Assert-Current ($actual.Count -eq $expected.Count)
  for($i=0;$i -lt $expected.Count;$i++){ Assert-Current ($actual[$i] -ceq $expected[$i]) }
}
function Read-JsonObject([string]$Path) {
  Assert-Current (Test-Path -LiteralPath $Path -PathType Leaf)
  try { Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } catch { Fail-Current }
}
function Assert-LiveEvidence($Evidence,$CandidateFacts,$SkillFacts) {
  Assert-ExactFields $Evidence $evidenceFields
  Assert-Current ($Evidence.schema -ceq "HAIOS_B6_STAGE1_LIVE_QUALIFICATION_R1" -and $Evidence.stage -ceq "SKILL_FABRIC" -and $Evidence.targetProjectId -ceq "skill-fabric" -and $Evidence.result -ceq "PASS")
  Assert-Current ($Evidence.b6CandidateHeadSha -ceq $CandidateFacts.head -and $Evidence.b6CandidateManifestSha256 -ceq $CandidateFacts.manifestSha256)
  Assert-Current ($Evidence.skillFabricHeadSha -ceq $SkillFacts.head -and $Evidence.skillFabricManifestSha256 -ceq $SkillFacts.manifestSha256)
  Assert-Current ($Evidence.exact13Tools -eq $true -and $Evidence.projectAdmitted -eq $true -and $Evidence.hermesOsDenied -eq $true)
  Assert-Current ($Evidence.canonicalPreHeadSha -ceq $SkillFacts.head -and $Evidence.canonicalPostHeadSha -ceq $SkillFacts.head)
  Assert-Current ($Evidence.canonicalPreStatusClean -eq $true -and $Evidence.canonicalPostStatusClean -eq $true -and [int]$Evidence.ownedResidueCount -eq 0)
  Assert-Current ($Evidence.effectPolicyVerified -eq $true -and $Evidence.networkAuthority -ceq "NONE" -and $Evidence.rollbackRecoveryClassification -ceq "SAFE_TO_ROLLBACK")
}
function Assert-StageOneCertificateCurrent([string]$Path,$CandidateFacts,$SkillFacts) {
  $certificate=Read-JsonObject $Path; Assert-ExactFields $certificate $certificateFields
  Assert-Current ($certificate.schema -ceq "HAIOS_B6_STAGE_CERTIFICATION_R1" -and $certificate.stage -ceq "SKILL_FABRIC" -and $certificate.terminal -ceq $stage1Terminal -and $certificate.targetProjectId -ceq "skill-fabric")
  Assert-Current ($certificate.b6CandidateHeadSha -ceq $CandidateFacts.head -and [int]$certificate.b6CandidateTrackedCount -eq [int]$CandidateFacts.trackedCount -and $certificate.b6CandidateManifestSha256 -ceq $CandidateFacts.manifestSha256)
  Assert-Current ($certificate.canonicalPath -ceq $SkillFacts.canonicalPath -and $certificate.gitCommonDirIdentity -ceq $SkillFacts.gitCommonDirIdentity)
  Assert-Current ($certificate.targetHeadSha -ceq $SkillFacts.head -and [int]$certificate.targetTrackedCount -eq [int]$SkillFacts.trackedCount -and $certificate.targetManifestSha256 -ceq $SkillFacts.manifestSha256 -and $SkillFacts.clean -eq $true)
  Assert-Current ($certificate.liveQualificationResult -ceq "PASS" -and $certificate.exact13Tools -eq $true -and $certificate.projectAdmitted -eq $true -and $certificate.hermesOsDenied -eq $true)
  Assert-Current ($certificate.canonicalPreHeadSha -ceq $SkillFacts.head -and $certificate.canonicalPostHeadSha -ceq $SkillFacts.head -and $certificate.canonicalPreStatusClean -eq $true -and $certificate.canonicalPostStatusClean -eq $true -and [int]$certificate.ownedResidueCount -eq 0)
  Assert-Current ($certificate.effectPolicyVerified -eq $true -and $certificate.networkAuthority -ceq "NONE" -and $certificate.rollbackRecoveryClassification -ceq "SAFE_TO_ROLLBACK")
  try { [void][DateTimeOffset]::ParseExact([string]$certificate.createdAt,"o",[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal) } catch { Fail-Current }
  $unsigned=[ordered]@{}; foreach($field in $certificateFields){if($field -cne "certificationSha256"){$unsigned[$field]=$certificate.$field}}
  Assert-Current ($certificate.certificationSha256 -cmatch "^[a-f0-9]{64}$" -and $certificate.certificationSha256 -ceq (Get-CanonicalSha256 $unsigned))
  Assert-Current (Same-Path ([string]$certificate.liveQualificationEvidencePath) $expectedEvidencePath)
  Assert-Current (Test-Path -LiteralPath $expectedEvidencePath -PathType Leaf)
  Assert-Current ($certificate.liveQualificationEvidenceSha256 -ceq (Get-Sha256 $expectedEvidencePath))
  $evidence=Read-JsonObject $expectedEvidencePath; Assert-LiveEvidence $evidence $CandidateFacts $SkillFacts
}
if($CandidateManifestSha256 -notmatch "^[a-f0-9]{64}$"){ throw "B6_CANDIDATE_MANIFEST_INVALID" }
$candidateFacts=Get-RepositoryFacts $RepoRoot; Assert-Current ($candidateFacts.clean -eq $true)
if($CandidateManifestSha256 -cne $candidateFacts.manifestSha256){ throw "B6_CANDIDATE_MANIFEST_NOT_CURRENT" }
$skillFacts=Get-RepositoryFacts $roots["skill-fabric"]; if(-not $skillFacts.clean){ throw "B6_CANONICAL_CLEAN_REQUIRED_skill-fabric" }
if($Stage -eq "SKILL_FABRIC"){
  if([string]::IsNullOrWhiteSpace($EvidencePath) -or [string]::IsNullOrWhiteSpace($CertificationPath)){ throw "B6_STAGE_ONE_CERTIFICATION_REQUIRED" }
  Assert-Current (Same-Path $EvidencePath $expectedEvidencePath); Assert-Current (Same-Path $CertificationPath $expectedCertificationPath)
  $evidence=Read-JsonObject $EvidencePath; Assert-LiveEvidence $evidence $candidateFacts $skillFacts
  $unsigned=[ordered]@{
    schema="HAIOS_B6_STAGE_CERTIFICATION_R1"; stage="SKILL_FABRIC"; terminal=$stage1Terminal; targetProjectId="skill-fabric"
    b6CandidateHeadSha=$candidateFacts.head; b6CandidateTrackedCount=$candidateFacts.trackedCount; b6CandidateManifestSha256=$candidateFacts.manifestSha256
    canonicalPath=$skillFacts.canonicalPath; gitCommonDirIdentity=$skillFacts.gitCommonDirIdentity; targetHeadSha=$skillFacts.head; targetTrackedCount=$skillFacts.trackedCount; targetManifestSha256=$skillFacts.manifestSha256
    liveQualificationEvidencePath=[IO.Path]::GetFullPath($expectedEvidencePath); liveQualificationEvidenceSha256=(Get-Sha256 $expectedEvidencePath); liveQualificationResult="PASS"
    exact13Tools=$true; projectAdmitted=$true; hermesOsDenied=$true; canonicalPreHeadSha=$skillFacts.head; canonicalPostHeadSha=$skillFacts.head
    canonicalPreStatusClean=$true; canonicalPostStatusClean=$true; ownedResidueCount=0; effectPolicyVerified=$true; networkAuthority="NONE"; rollbackRecoveryClassification="SAFE_TO_ROLLBACK"
    createdAt=[DateTime]::UtcNow.ToString("o")
  }
  $certificate=[ordered]@{}; foreach($field in $certificateFields){if($field -ceq "certificationSha256"){$certificate[$field]=Get-CanonicalSha256 $unsigned}else{$certificate[$field]=$unsigned[$field]}}
  [IO.File]::WriteAllText($CertificationPath,((ConvertTo-CanonicalJson $certificate)+"`n"),[Text.UTF8Encoding]::new($false))
} else {
  if([string]::IsNullOrWhiteSpace($StageOneCertificationPath) -or -not(Test-Path -LiteralPath $StageOneCertificationPath -PathType Leaf)){ throw "B6_STAGE_ONE_CERTIFICATION_REQUIRED" }
  Assert-Current (Same-Path $StageOneCertificationPath $expectedCertificationPath)
  Assert-StageOneCertificateCurrent $StageOneCertificationPath $candidateFacts $skillFacts
}
$admitted=if($Stage -eq "SKILL_FABRIC"){@("operator-canary","skill-fabric")}else{@("operator-canary","skill-fabric","hermes-os")}
foreach($id in $admitted){
  $facts=Get-RepositoryFacts $roots[$id]
  if(-not $facts.clean){ throw "B6_CANONICAL_CLEAN_REQUIRED_$id" }
}
[pscustomobject]@{
  schema="HAIOS_B6_PREFLIGHT_R1"; stage=$Stage; candidateHeadSha=$candidateFacts.head; candidateTrackedCount=$candidateFacts.trackedCount
  candidateManifestSha256=$candidateFacts.manifestSha256; admittedProjects=$admitted; port=8769
  m12Rollback="CERTIFIED_M12"; stageTwoRollback="QUALIFIED_B6_SKILL_FABRIC"
  s2Enabled=$false; genericExec=$false; genericShell=$false; destructive="LOCKED"; networkAuthority="NONE"
} | ConvertTo-Json -Compress
