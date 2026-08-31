[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet("SKILL_FABRIC", "HERMES_OS")][string]$Stage,
  [Parameter(Mandatory = $true)][string]$CandidateManifestSha256,
  [string]$EvidencePath,
  [string]$CertificationPath,
  [string]$StageOneCertificationPath,
  [switch]$ValidateOnly
)
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$roots = @{ "operator-canary" = "C:\Workspace\haios-operator-canary"; "skill-fabric" = "C:\Workspace\haios-skill-fabric"; "hermes-os" = "C:\Workspace\hermes-ai-operating-system-b6-canonical" }
$certifiedTargets = @{
  "skill-fabric" = @{ head="51790d8fa098fa4b07b1424faee604dde9fa89fe"; trackedCount=47; manifestSha256="2aafb2c5f568ff49d4a1cc3b623cd36e0a49e7708e665ff78a48d3b1a084f340" }
  "hermes-os" = @{ head="94b43820e43060e4504f26e514d71d3024236871"; trackedCount=96; manifestSha256="cc4d70d2d61f18ea03d240808022cf4894269b8a2191752c270b2f2b1640c934" }
}
$stage1Terminal = "HAIOS_DESKTOP_CONTROL_PLANE_R1_B6_SKILL_FABRIC_ADMISSION_QUALIFIED"
$stage2Terminal = "HAIOS_DESKTOP_CONTROL_PLANE_R1_B6_HERMES_OS_ADMISSION_QUALIFIED"
$evidenceRoot = Join-Path $env:LOCALAPPDATA "HAIOS\B6\evidence\stage1"
$expectedEvidencePath = Join-Path $evidenceRoot "stage1-live-qualification.json"
$expectedCertificationPath = Join-Path $evidenceRoot "stage1-final-certification.json"
$stage2EvidenceRoot = Join-Path $env:LOCALAPPDATA "HAIOS\B6\evidence\stage2"
$expectedStage2EvidencePath = Join-Path $stage2EvidenceRoot "stage2-live-qualification.json"
$expectedStage2CertificationPath = Join-Path $stage2EvidenceRoot "stage2-final-certification.json"
$operatorKeyPath = Join-Path $env:LOCALAPPDATA "HAIOS\M10\operator-api-key"
$certificateFields = @("schema","stage","terminal","targetProjectId","b6CandidateHeadSha","b6CandidateTrackedCount","b6CandidateManifestSha256","canonicalPath","gitCommonDirIdentity","targetHeadSha","targetTrackedCount","targetManifestSha256","liveQualificationEvidencePath","liveQualificationEvidenceSha256","liveQualificationResult","exact13Tools","projectAdmitted","hermesOsDenied","canonicalPreHeadSha","canonicalPostHeadSha","canonicalPreStatusClean","canonicalPostStatusClean","ownedResidueCount","effectPolicyVerified","networkAuthority","rollbackRecoveryClassification","createdAt","liveQualificationEvidenceHmacSha256","certificationSha256","certificationHmacSha256")
$evidenceFields = @("schema","stage","targetProjectId","result","b6CandidateHeadSha","b6CandidateManifestSha256","skillFabricHeadSha","skillFabricManifestSha256","exact13Tools","projectAdmitted","hermesOsDenied","canonicalPreHeadSha","canonicalPostHeadSha","canonicalPreStatusClean","canonicalPostStatusClean","ownedResidueCount","effectPolicyVerified","networkAuthority","rollbackRecoveryClassification")
$stage2EvidenceFields = @("schema","stage","targetProjectId","result","b6CandidateHeadSha","b6CandidateManifestSha256","stageOneCertificationSha256","skillFabricHeadSha","skillFabricManifestSha256","hermesOsHeadSha","hermesOsManifestSha256","exact13Tools","projectAdmitted","skillFabricRegression","operatorCanaryRegression","wrongRootDenied","unknownProjectDenied","canonicalPreHeadSha","canonicalPostHeadSha","canonicalPreStatusClean","canonicalPostStatusClean","ownedResidueCount","effectPolicyVerified","networkAuthority","rollbackRecoveryClassification")
$stage2CertificateFields = @("schema","stage","terminal","targetProjectId","b6CandidateHeadSha","b6CandidateTrackedCount","b6CandidateManifestSha256","canonicalPath","gitCommonDirIdentity","targetHeadSha","targetTrackedCount","targetManifestSha256","stageOneCertificationPath","stageOneCertificationSha256","liveQualificationEvidencePath","liveQualificationEvidenceSha256","liveQualificationResult","exact13Tools","projectAdmitted","skillFabricRegression","operatorCanaryRegression","wrongRootDenied","canonicalPreHeadSha","canonicalPostHeadSha","canonicalPreStatusClean","canonicalPostStatusClean","ownedResidueCount","effectPolicyVerified","networkAuthority","rollbackRecoveryClassification","createdAt","liveQualificationEvidenceHmacSha256","certificationSha256","certificationHmacSha256")
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
function Get-OperatorHmac([byte[]]$Bytes) {
  Assert-Current (Test-Path -LiteralPath $operatorKeyPath -PathType Leaf)
  $keyText=[IO.File]::ReadAllText($operatorKeyPath,[Text.Encoding]::UTF8).Trim()
  Assert-Current ($keyText.Length -ge 16 -and $keyText.Length -le 512)
  $hmac=[Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($keyText))
  try { ([BitConverter]::ToString($hmac.ComputeHash($Bytes))).Replace("-","").ToLowerInvariant() } finally { $hmac.Dispose() }
}
function Get-CanonicalHmac($Value) { Get-OperatorHmac ([Text.Encoding]::UTF8.GetBytes((ConvertTo-CanonicalJson $Value))) }
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
function Assert-CertifiedTarget([string]$ProjectId,$Facts) {
  $expected=$certifiedTargets[$ProjectId]
  if($null -eq $expected -or $Facts.head -cne $expected.head -or [int]$Facts.trackedCount -ne [int]$expected.trackedCount -or $Facts.manifestSha256 -cne $expected.manifestSha256 -or $Facts.clean -ne $true){
    throw "B6_CERTIFIED_BASELINE_NOT_CURRENT_$ProjectId"
  }
}
function Assert-ExactFields($Object,[string[]]$Fields) {
  $actual=@($Object.PSObject.Properties.Name | Sort-Object -CaseSensitive); $expected=@($Fields | Sort-Object -CaseSensitive)
  Assert-Current ($actual.Count -eq $expected.Count)
  for($i=0;$i -lt $expected.Count;$i++){ Assert-Current ($actual[$i] -ceq $expected[$i]) }
}
function Read-JsonObject([string]$Path) {
  Assert-Current (Test-Path -LiteralPath $Path -PathType Leaf)
  try { Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -DateKind String -ErrorAction Stop } catch { Fail-Current }
}
function Commit-StagedFile([string]$StagedPath,[string]$DestinationPath) {
  Assert-Current (Test-Path -LiteralPath $StagedPath -PathType Leaf)
  if(Test-Path -LiteralPath $DestinationPath -PathType Leaf){
    $backupPath="$DestinationPath.replace-backup-$PID-$([guid]::NewGuid().ToString('N'))"
    try { [IO.File]::Replace($StagedPath,$DestinationPath,$backupPath,$true) }
    finally { if(Test-Path -LiteralPath $backupPath -PathType Leaf){ [IO.File]::Delete($backupPath) } }
  } else { [IO.File]::Move($StagedPath,$DestinationPath) }
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
function Assert-StageTwoLiveEvidence($Evidence,$CandidateFacts,$SkillFacts,$HermesFacts,[string]$StageOneSha) {
  Assert-ExactFields $Evidence $stage2EvidenceFields
  Assert-Current ($Evidence.schema -ceq "HAIOS_B6_STAGE2_LIVE_QUALIFICATION_R1" -and $Evidence.stage -ceq "HERMES_OS" -and $Evidence.targetProjectId -ceq "hermes-os" -and $Evidence.result -ceq "PASS")
  Assert-Current ($Evidence.b6CandidateHeadSha -ceq $CandidateFacts.head -and $Evidence.b6CandidateManifestSha256 -ceq $CandidateFacts.manifestSha256 -and $Evidence.stageOneCertificationSha256 -ceq $StageOneSha)
  Assert-Current ($Evidence.skillFabricHeadSha -ceq $SkillFacts.head -and $Evidence.skillFabricManifestSha256 -ceq $SkillFacts.manifestSha256)
  Assert-Current ($Evidence.hermesOsHeadSha -ceq $HermesFacts.head -and $Evidence.hermesOsManifestSha256 -ceq $HermesFacts.manifestSha256)
  Assert-Current ($Evidence.exact13Tools -eq $true -and $Evidence.projectAdmitted -eq $true -and $Evidence.skillFabricRegression -eq $true -and $Evidence.operatorCanaryRegression -eq $true -and $Evidence.wrongRootDenied -eq $true -and $Evidence.unknownProjectDenied -eq $true)
  Assert-Current ($Evidence.canonicalPreHeadSha -ceq $HermesFacts.head -and $Evidence.canonicalPostHeadSha -ceq $HermesFacts.head -and $Evidence.canonicalPreStatusClean -eq $true -and $Evidence.canonicalPostStatusClean -eq $true -and [int]$Evidence.ownedResidueCount -eq 0)
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
  try { $created=[DateTimeOffset]::ParseExact([string]$certificate.createdAt,"o",[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal) } catch { Fail-Current }
  $ageSeconds=([DateTimeOffset]::UtcNow-$created.ToUniversalTime()).TotalSeconds
  Assert-Current ($ageSeconds -ge -60 -and $ageSeconds -le 900)
  $unsigned=[ordered]@{}; foreach($field in $certificateFields){if($field -cne "certificationSha256" -and $field -cne "certificationHmacSha256"){$unsigned[$field]=$certificate.$field}}
  Assert-Current ($certificate.certificationSha256 -cmatch "^[a-f0-9]{64}$" -and $certificate.certificationSha256 -ceq (Get-CanonicalSha256 $unsigned))
  $authenticated=[ordered]@{}; foreach($field in $certificateFields){if($field -cne "certificationHmacSha256"){$authenticated[$field]=$certificate.$field}}
  Assert-Current ($certificate.certificationHmacSha256 -cmatch "^[a-f0-9]{64}$" -and $certificate.certificationHmacSha256 -ceq (Get-CanonicalHmac $authenticated))
  Assert-Current (Same-Path ([string]$certificate.liveQualificationEvidencePath) $expectedEvidencePath)
  Assert-Current (Test-Path -LiteralPath $expectedEvidencePath -PathType Leaf)
  Assert-Current ($certificate.liveQualificationEvidenceSha256 -ceq (Get-Sha256 $expectedEvidencePath))
  Assert-Current ($certificate.liveQualificationEvidenceHmacSha256 -cmatch "^[a-f0-9]{64}$" -and $certificate.liveQualificationEvidenceHmacSha256 -ceq (Get-OperatorHmac ([IO.File]::ReadAllBytes($expectedEvidencePath))))
  $evidence=Read-JsonObject $expectedEvidencePath; Assert-LiveEvidence $evidence $CandidateFacts $SkillFacts
}
function Assert-StageTwoCertificateCurrent([string]$Path,$CandidateFacts,$SkillFacts,$HermesFacts,[string]$StageOnePath) {
  $certificate=Read-JsonObject $Path; Assert-ExactFields $certificate $stage2CertificateFields
  Assert-Current ($certificate.schema -ceq "HAIOS_B6_STAGE_CERTIFICATION_R1" -and $certificate.stage -ceq "HERMES_OS" -and $certificate.terminal -ceq $stage2Terminal -and $certificate.targetProjectId -ceq "hermes-os")
  Assert-Current ($certificate.b6CandidateHeadSha -ceq $CandidateFacts.head -and [int]$certificate.b6CandidateTrackedCount -eq [int]$CandidateFacts.trackedCount -and $certificate.b6CandidateManifestSha256 -ceq $CandidateFacts.manifestSha256)
  Assert-Current ($certificate.canonicalPath -ceq $HermesFacts.canonicalPath -and $certificate.gitCommonDirIdentity -ceq $HermesFacts.gitCommonDirIdentity)
  Assert-Current ($certificate.targetHeadSha -ceq $HermesFacts.head -and [int]$certificate.targetTrackedCount -eq [int]$HermesFacts.trackedCount -and $certificate.targetManifestSha256 -ceq $HermesFacts.manifestSha256 -and $HermesFacts.clean -eq $true)
  Assert-Current (Same-Path ([string]$certificate.stageOneCertificationPath) $StageOnePath)
  Assert-Current ($certificate.stageOneCertificationSha256 -ceq (Get-Sha256 $StageOnePath))
  Assert-Current (Same-Path ([string]$certificate.liveQualificationEvidencePath) $expectedStage2EvidencePath)
  Assert-Current (Test-Path -LiteralPath $expectedStage2EvidencePath -PathType Leaf)
  Assert-Current ($certificate.liveQualificationEvidenceSha256 -ceq (Get-Sha256 $expectedStage2EvidencePath) -and $certificate.liveQualificationResult -ceq "PASS")
  Assert-Current ($certificate.exact13Tools -eq $true -and $certificate.projectAdmitted -eq $true -and $certificate.skillFabricRegression -eq $true -and $certificate.operatorCanaryRegression -eq $true -and $certificate.wrongRootDenied -eq $true)
  Assert-Current ($certificate.canonicalPreHeadSha -ceq $HermesFacts.head -and $certificate.canonicalPostHeadSha -ceq $HermesFacts.head -and $certificate.canonicalPreStatusClean -eq $true -and $certificate.canonicalPostStatusClean -eq $true -and [int]$certificate.ownedResidueCount -eq 0)
  Assert-Current ($certificate.effectPolicyVerified -eq $true -and $certificate.networkAuthority -ceq "NONE" -and $certificate.rollbackRecoveryClassification -ceq "SAFE_TO_ROLLBACK")
  try { $created=[DateTimeOffset]::ParseExact([string]$certificate.createdAt,"o",[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal) } catch { Fail-Current }
  $ageSeconds=([DateTimeOffset]::UtcNow-$created.ToUniversalTime()).TotalSeconds; Assert-Current ($ageSeconds -ge -60 -and $ageSeconds -le 900)
  $unsigned=[ordered]@{}; foreach($field in $stage2CertificateFields){if($field -cne "certificationSha256" -and $field -cne "certificationHmacSha256"){$unsigned[$field]=$certificate.$field}}
  Assert-Current ($certificate.certificationSha256 -cmatch "^[a-f0-9]{64}$" -and $certificate.certificationSha256 -ceq (Get-CanonicalSha256 $unsigned))
  $authenticated=[ordered]@{}; foreach($field in $stage2CertificateFields){if($field -cne "certificationHmacSha256"){$authenticated[$field]=$certificate.$field}}
  Assert-Current ($certificate.certificationHmacSha256 -cmatch "^[a-f0-9]{64}$" -and $certificate.certificationHmacSha256 -ceq (Get-CanonicalHmac $authenticated))
  Assert-Current ($certificate.liveQualificationEvidenceHmacSha256 -cmatch "^[a-f0-9]{64}$" -and $certificate.liveQualificationEvidenceHmacSha256 -ceq (Get-OperatorHmac ([IO.File]::ReadAllBytes($expectedStage2EvidencePath))))
  $evidence=Read-JsonObject $expectedStage2EvidencePath; Assert-StageTwoLiveEvidence $evidence $CandidateFacts $SkillFacts $HermesFacts $certificate.stageOneCertificationSha256
}
if($CandidateManifestSha256 -notmatch "^[a-f0-9]{64}$"){ throw "B6_CANDIDATE_MANIFEST_INVALID" }
$candidateFacts=Get-RepositoryFacts $RepoRoot; Assert-Current ($candidateFacts.clean -eq $true)
if($CandidateManifestSha256 -cne $candidateFacts.manifestSha256){ throw "B6_CANDIDATE_MANIFEST_NOT_CURRENT" }
$skillFacts=Get-RepositoryFacts $roots["skill-fabric"]; if(-not $skillFacts.clean){ throw "B6_CANONICAL_CLEAN_REQUIRED_skill-fabric" }; Assert-CertifiedTarget "skill-fabric" $skillFacts
if($Stage -eq "SKILL_FABRIC"){
  if([string]::IsNullOrWhiteSpace($EvidencePath) -or [string]::IsNullOrWhiteSpace($CertificationPath)){ throw "B6_STAGE_ONE_CERTIFICATION_REQUIRED" }
  Assert-Current (Same-Path $EvidencePath $expectedEvidencePath); Assert-Current (Same-Path $CertificationPath $expectedCertificationPath)
  if($ValidateOnly){ Assert-StageOneCertificateCurrent $expectedCertificationPath $candidateFacts $skillFacts } else {
  $stagedEvidencePath="$expectedEvidencePath.candidate-$PID-$([guid]::NewGuid().ToString('N'))"
  $stagedCertificationPath="$expectedCertificationPath.candidate-$PID-$([guid]::NewGuid().ToString('N'))"
  try {
    & node.exe (Join-Path $PSScriptRoot "qualify-b6-live-stage.mjs") "SKILL_FABRIC" $CandidateManifestSha256 $stagedEvidencePath | Out-Null
    if($LASTEXITCODE -ne 0 -or -not(Test-Path -LiteralPath $stagedEvidencePath -PathType Leaf)){ throw "B6_STAGE_ONE_LIVE_QUALIFICATION_FAILED" }
    $stagedEvidence=Read-JsonObject $stagedEvidencePath; Assert-LiveEvidence $stagedEvidence $candidateFacts $skillFacts
    Commit-StagedFile $stagedEvidencePath $expectedEvidencePath
    $evidence=Read-JsonObject $expectedEvidencePath; Assert-LiveEvidence $evidence $candidateFacts $skillFacts
    $unsigned=[ordered]@{
      schema="HAIOS_B6_STAGE_CERTIFICATION_R1"; stage="SKILL_FABRIC"; terminal=$stage1Terminal; targetProjectId="skill-fabric"
      b6CandidateHeadSha=$candidateFacts.head; b6CandidateTrackedCount=$candidateFacts.trackedCount; b6CandidateManifestSha256=$candidateFacts.manifestSha256
      canonicalPath=$skillFacts.canonicalPath; gitCommonDirIdentity=$skillFacts.gitCommonDirIdentity; targetHeadSha=$skillFacts.head; targetTrackedCount=$skillFacts.trackedCount; targetManifestSha256=$skillFacts.manifestSha256
      liveQualificationEvidencePath=[IO.Path]::GetFullPath($expectedEvidencePath); liveQualificationEvidenceSha256=(Get-Sha256 $expectedEvidencePath); liveQualificationEvidenceHmacSha256=(Get-OperatorHmac ([IO.File]::ReadAllBytes($expectedEvidencePath))); liveQualificationResult="PASS"
      exact13Tools=$true; projectAdmitted=$true; hermesOsDenied=$true; canonicalPreHeadSha=$skillFacts.head; canonicalPostHeadSha=$skillFacts.head
      canonicalPreStatusClean=$true; canonicalPostStatusClean=$true; ownedResidueCount=0; effectPolicyVerified=$true; networkAuthority="NONE"; rollbackRecoveryClassification="SAFE_TO_ROLLBACK"; createdAt=[DateTimeOffset]::UtcNow.ToString("o")
    }
    $certificate=[ordered]@{}; foreach($field in $certificateFields){
      if($field -ceq "certificationSha256"){$certificate[$field]=Get-CanonicalSha256 $unsigned}
      elseif($field -ceq "certificationHmacSha256"){$certificate[$field]=Get-CanonicalHmac $certificate}
      else{$certificate[$field]=$unsigned[$field]}
    }
    [IO.File]::WriteAllText($stagedCertificationPath,((ConvertTo-CanonicalJson $certificate)+"`n"),[Text.UTF8Encoding]::new($false))
    Commit-StagedFile $stagedCertificationPath $expectedCertificationPath
    Assert-StageOneCertificateCurrent $expectedCertificationPath $candidateFacts $skillFacts
  } finally {
    if(Test-Path -LiteralPath $stagedEvidencePath){ [IO.File]::Delete($stagedEvidencePath) }
    if(Test-Path -LiteralPath $stagedCertificationPath){ [IO.File]::Delete($stagedCertificationPath) }
  }
  }
} else {
  if([string]::IsNullOrWhiteSpace($StageOneCertificationPath) -or -not(Test-Path -LiteralPath $StageOneCertificationPath -PathType Leaf)){ throw "B6_STAGE_ONE_CERTIFICATION_REQUIRED" }
  Assert-Current (Same-Path $StageOneCertificationPath $expectedCertificationPath)
  Assert-StageOneCertificateCurrent $StageOneCertificationPath $candidateFacts $skillFacts
  $hermesFacts=Get-RepositoryFacts $roots["hermes-os"]; Assert-CertifiedTarget "hermes-os" $hermesFacts
  $stageOneFileSha=Get-Sha256 $StageOneCertificationPath
  if($ValidateOnly){
    if([string]::IsNullOrWhiteSpace($EvidencePath) -or [string]::IsNullOrWhiteSpace($CertificationPath)){ throw "B6_STAGE_TWO_CERTIFICATION_REQUIRED" }
    Assert-Current (Same-Path $EvidencePath $expectedStage2EvidencePath); Assert-Current (Same-Path $CertificationPath $expectedStage2CertificationPath)
    Assert-StageTwoCertificateCurrent $expectedStage2CertificationPath $candidateFacts $skillFacts $hermesFacts $StageOneCertificationPath
  } elseif([string]::IsNullOrWhiteSpace($EvidencePath) -and [string]::IsNullOrWhiteSpace($CertificationPath)){
    & node.exe (Join-Path $PSScriptRoot "probe-b6-project-expansion-host.mjs") "SKILL_FABRIC" | Out-Null
    if($LASTEXITCODE -ne 0){ throw "B6_STAGE_ONE_LIVE_RUNTIME_NOT_CURRENT" }
  } else {
    if([string]::IsNullOrWhiteSpace($EvidencePath) -or [string]::IsNullOrWhiteSpace($CertificationPath)){ throw "B6_STAGE_TWO_CERTIFICATION_REQUIRED" }
    Assert-Current (Same-Path $EvidencePath $expectedStage2EvidencePath); Assert-Current (Same-Path $CertificationPath $expectedStage2CertificationPath)
    & node.exe (Join-Path $PSScriptRoot "probe-b6-project-expansion-host.mjs") "HERMES_OS" | Out-Null
    if($LASTEXITCODE -ne 0){ throw "B6_STAGE_TWO_LIVE_RUNTIME_NOT_CURRENT" }
    $stagedEvidencePath="$expectedStage2EvidencePath.candidate-$PID-$([guid]::NewGuid().ToString('N'))"
    $stagedCertificationPath="$expectedStage2CertificationPath.candidate-$PID-$([guid]::NewGuid().ToString('N'))"
    try {
      & node.exe (Join-Path $PSScriptRoot "qualify-b6-live-stage.mjs") "HERMES_OS" $CandidateManifestSha256 $stagedEvidencePath $stageOneFileSha | Out-Null
      if($LASTEXITCODE -ne 0 -or -not(Test-Path -LiteralPath $stagedEvidencePath -PathType Leaf)){ throw "B6_STAGE_TWO_LIVE_QUALIFICATION_FAILED" }
      $stagedEvidence=Read-JsonObject $stagedEvidencePath; Assert-StageTwoLiveEvidence $stagedEvidence $candidateFacts $skillFacts $hermesFacts $stageOneFileSha
      Commit-StagedFile $stagedEvidencePath $expectedStage2EvidencePath
      $stage2Evidence=Read-JsonObject $expectedStage2EvidencePath; Assert-StageTwoLiveEvidence $stage2Evidence $candidateFacts $skillFacts $hermesFacts $stageOneFileSha
      $unsigned=[ordered]@{
        schema="HAIOS_B6_STAGE_CERTIFICATION_R1"; stage="HERMES_OS"; terminal=$stage2Terminal; targetProjectId="hermes-os"
        b6CandidateHeadSha=$candidateFacts.head; b6CandidateTrackedCount=$candidateFacts.trackedCount; b6CandidateManifestSha256=$candidateFacts.manifestSha256
        canonicalPath=$hermesFacts.canonicalPath; gitCommonDirIdentity=$hermesFacts.gitCommonDirIdentity; targetHeadSha=$hermesFacts.head; targetTrackedCount=$hermesFacts.trackedCount; targetManifestSha256=$hermesFacts.manifestSha256
        stageOneCertificationPath=[IO.Path]::GetFullPath($StageOneCertificationPath); stageOneCertificationSha256=$stageOneFileSha
        liveQualificationEvidencePath=[IO.Path]::GetFullPath($expectedStage2EvidencePath); liveQualificationEvidenceSha256=(Get-Sha256 $expectedStage2EvidencePath); liveQualificationEvidenceHmacSha256=(Get-OperatorHmac ([IO.File]::ReadAllBytes($expectedStage2EvidencePath))); liveQualificationResult="PASS"
        exact13Tools=$true; projectAdmitted=$true; skillFabricRegression=$true; operatorCanaryRegression=$true; wrongRootDenied=$true
        canonicalPreHeadSha=$hermesFacts.head; canonicalPostHeadSha=$hermesFacts.head; canonicalPreStatusClean=$true; canonicalPostStatusClean=$true; ownedResidueCount=0
        effectPolicyVerified=$true; networkAuthority="NONE"; rollbackRecoveryClassification="SAFE_TO_ROLLBACK"; createdAt=[DateTimeOffset]::UtcNow.ToString("o")
      }
      $certificate=[ordered]@{}; foreach($field in $stage2CertificateFields){
        if($field -ceq "certificationSha256"){$certificate[$field]=Get-CanonicalSha256 $unsigned}
        elseif($field -ceq "certificationHmacSha256"){$certificate[$field]=Get-CanonicalHmac $certificate}
        else{$certificate[$field]=$unsigned[$field]}
      }
      [IO.File]::WriteAllText($stagedCertificationPath,((ConvertTo-CanonicalJson $certificate)+"`n"),[Text.UTF8Encoding]::new($false))
      Commit-StagedFile $stagedCertificationPath $expectedStage2CertificationPath
      Assert-StageTwoCertificateCurrent $expectedStage2CertificationPath $candidateFacts $skillFacts $hermesFacts $StageOneCertificationPath
    } finally {
      if(Test-Path -LiteralPath $stagedEvidencePath){ [IO.File]::Delete($stagedEvidencePath) }
      if(Test-Path -LiteralPath $stagedCertificationPath){ [IO.File]::Delete($stagedCertificationPath) }
    }
  }
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
