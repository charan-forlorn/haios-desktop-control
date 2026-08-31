param(
  [Parameter(Mandatory=$true)][string]$EvidenceRoot
)
$ErrorActionPreference="Stop"
$PSNativeCommandUseErrorActionPreference=$true
if($PSVersionTable.PSVersion.Major -lt 7){throw "POWERSHELL_7_REQUIRED"}
$Root=(Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$EvidenceRoot=[IO.Path]::GetFullPath($EvidenceRoot)
$Terminal="HAIOS_DESKTOP_CONTROL_PLANE_R1_M12_B5_CANARY_STABILITY_READY_FOR_EXACT_HUMAN_ACTIVATION_DECISION"
$NextDecision="APPROVE HAIOS_DESKTOP_CONTROL_PLANE_R1_M12_B5_CANARY_STABILITY_ACTIVATION"
$M11FinalTerminal="HAIOS_DESKTOP_CONTROL_PLANE_R1_M11_ACTIVE_CANARY_QUALIFIED"
$M11FinalCertification="C:\Workspace\haios-desktop-control-m11\evidence\m11\final\m11-final-certification.json"
$M11CertifiedHead="1c32ba789ce89872b36bfed5f7a527b917072d6b"
$M11CertifiedManifest="ad2086df0f8bf6993fbe3756084d826d07b2f58b632d6ab49c1491210640815a"
$M11Task="HAIOS-M11-Operator-Active-Canary"
$M12Task="HAIOS-M12-Operator-B5-Canary-Stability"
$CanaryRoot="C:\Workspace\haios-operator-canary"
$DedicatedTunnel="haios-operator-dedicated-tunnel-client";$SharedTunnel="haios-tunnel-client";$ExpectedTunnelRoute="host.docker.internal:8769/mcp"
function Get-Sha256([string]$Path){(Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()}
function Write-JsonNoBom([string]$Path,$Object){[IO.File]::WriteAllText($Path,(($Object|ConvertTo-Json -Depth 20)+"`n"),[Text.UTF8Encoding]::new($false))}
function Get-Manifest([string]$RepoRoot){
  $paths=[string[]]@(& git.exe -C $RepoRoot ls-files);if($LASTEXITCODE -ne 0){throw "M12_PRELIVE_MANIFEST_ENUM_FAILED"};[Array]::Sort($paths,[StringComparer]::Ordinal)
  $rows=foreach($rel in $paths){[ordered]@{rel=$rel.Replace('\','/');sha256=Get-Sha256 (Join-Path $RepoRoot $rel)}}
  $text=(($rows|ForEach-Object{"$($_.sha256)  $($_.rel)"})-join "`n")+"`n";$bytes=[Text.Encoding]::UTF8.GetBytes($text);$digest=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
  [pscustomobject]@{rows=$rows;text=$text;digest=$digest;count=$paths.Count}
}
function Get-ListenerIdentity([int]$PortNumber){@((Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue|Sort-Object LocalAddress,OwningProcess|ForEach-Object{"$($_.LocalAddress)|$($_.LocalPort)|$($_.OwningProcess)"}))}
function Get-ContainerDigest([string]$Name){
  $raw=& docker.exe inspect $Name 2>$null;if($LASTEXITCODE -ne 0 -or -not $raw){throw "M12_PRELIVE_CONTAINER_UNAVAILABLE:$Name"};$o=($raw|ConvertFrom-Json)[0]
  $net=@($o.NetworkSettings.Networks.PSObject.Properties|Sort-Object Name|ForEach-Object{[ordered]@{name=$_.Name;network_id=$_.Value.NetworkID;endpoint_id=$_.Value.EndpointID;ip=$_.Value.IPAddress;gateway=$_.Value.Gateway}});$mount=@($o.Mounts|Sort-Object Destination,Type|ForEach-Object{[ordered]@{type=$_.Type;destination=$_.Destination;mode=$_.Mode;rw=$_.RW;propagation=$_.Propagation}})
  $snap=[ordered]@{id=$o.Id;created=$o.Created;image_id=$o.Image;config_image=$o.Config.Image;path=$o.Path;args=@($o.Args);network_mode=$o.HostConfig.NetworkMode;restart_policy=$o.HostConfig.RestartPolicy;mounts=$mount;networks=$net};$bytes=[Text.Encoding]::UTF8.GetBytes(($snap|ConvertTo-Json -Depth 8 -Compress));[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
function Invoke-Logged([string]$Name,[scriptblock]$Action){$log=Join-Path $EvidenceRoot "$Name.log";& $Action *> $log;if($LASTEXITCODE -ne 0){throw "M12_PRELIVE_${Name}_FAILED"};Get-Sha256 $log}
if((& git.exe -C $Root status --porcelain).Length -ne 0){throw "M12_PRELIVE_SOURCE_NOT_FROZEN"}
$candidate_head=(& git.exe -C $Root rev-parse HEAD).Trim();if($LASTEXITCODE -ne 0){throw "M12_PRELIVE_HEAD_READ_FAILED"}
$manifest=Get-Manifest $Root;$candidate_manifest_sha256=$manifest.digest;$tracked_count=$manifest.count
if(-not(Test-Path -LiteralPath $M11FinalCertification)){throw "M12_PRELIVE_M11_CERT_MISSING"};$cert=Get-Content -Raw -LiteralPath $M11FinalCertification|ConvertFrom-Json
if([string]$cert.terminal -ne $M11FinalTerminal -or [string]$cert.candidate_head -ne $M11CertifiedHead -or [string]$cert.candidate_manifest_sha256 -ne $M11CertifiedManifest){throw "M12_PRELIVE_M11_CERT_INVALID"};$m11_final_cert_sha256=Get-Sha256 $M11FinalCertification
if(-not(Test-Path -LiteralPath $CanaryRoot)){throw "M12_PRELIVE_CANARY_MISSING"};$canary_head_before=(& git.exe -C $CanaryRoot rev-parse HEAD).Trim();$canary_status_before=(@(& git.exe -C $CanaryRoot status --porcelain)-join "`n");if($LASTEXITCODE -ne 0 -or $canary_status_before -ne ""){throw "M12_PRELIVE_CANARY_NOT_CLEAN"}
$m11TaskBefore=Get-ScheduledTask -TaskName $M11Task -ErrorAction SilentlyContinue;if(-not $m11TaskBefore -or [string]$m11TaskBefore.State -ne 'Running'){throw "M12_PRELIVE_M11_NOT_RUNNING"};if(Get-ScheduledTask -TaskName $M12Task -ErrorAction SilentlyContinue){throw "M12_PRELIVE_M12_TASK_COLLISION"};$m11Action=@($m11TaskBefore.Actions)[0]
$listener8768Before=@(Get-ListenerIdentity 8768);$listener8769Before=@(Get-ListenerIdentity 8769);if($listener8768Before.Count -eq 0 -or $listener8769Before.Count -eq 0){throw "M12_PRELIVE_LISTENER_MISSING"}
$dedicatedBefore=Get-ContainerDigest $DedicatedTunnel;$sharedBefore=Get-ContainerDigest $SharedTunnel;$dedicated=(& docker.exe inspect $DedicatedTunnel|ConvertFrom-Json)[0];if(-not((@($dedicated.Args)-join ' ').Contains($ExpectedTunnelRoute))){throw "M12_PRELIVE_TUNNEL_ROUTE_DRIFT"}
New-Item -ItemType Directory -Force -Path $EvidenceRoot|Out-Null
[IO.File]::WriteAllText((Join-Path $EvidenceRoot "source-manifest.txt"),$manifest.text,[Text.UTF8Encoding]::new($false))
$full_test_sha256=Invoke-Logged "full-regression" {& npx.cmd vitest run --passWithNoTests --exclude 'dist/**' --maxWorkers=1}
$typecheck_sha256=Invoke-Logged "typecheck" {& npm.cmd run typecheck}
$build_sha256=Invoke-Logged "build" {& npm.cmd run build}
$diffCheckLog=Join-Path $EvidenceRoot "diff-check.log";& git.exe -C $Root diff --check *> $diffCheckLog;if($LASTEXITCODE -ne 0){throw "M12_PRELIVE_DIFF_CHECK_FAILED"};$diff_check_sha256=Get-Sha256 $diffCheckLog
$parserMembers=@("scripts\preflight-m12-b5-activation.ps1","scripts\execute-m12-b5-activation.ps1","scripts\rollback-m12-b5-to-m11.ps1","scripts\qualify-m12-prelive.ps1")
$parserResult=@();foreach($rel in $parserMembers){$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $Root $rel),[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count -gt 0){throw "M12_PRELIVE_POWERSHELL_PARSE_FAILED:$rel"};$parserResult+=[ordered]@{path=$rel;sha256=Get-Sha256 (Join-Path $Root $rel)}}
$secret_scan=[ordered]@{status="PASS";findings=@();patterns=@("OPENAI_API_KEY assignment","sk-proj- long token","sk- long token")}
foreach($rel in [string[]]@(& git.exe -C $Root ls-files)){$text=[IO.File]::ReadAllText((Join-Path $Root $rel));if($text -match 'sk-proj-[A-Za-z0-9_-]{20,}' -or $text -match 'sk-[A-Za-z0-9]{32,}' -or $text -match 'OPENAI_API_KEY\s*=\s*["''][^"'']{10,}'){ $secret_scan.status="FAIL";$secret_scan.findings+= $rel }}
if($secret_scan.status -ne "PASS"){throw "M12_PRELIVE_TRACKED_SECRET_SCAN_FAILED"};Write-JsonNoBom (Join-Path $EvidenceRoot "secret-scan.json") $secret_scan
$disposableRoot=Join-Path $EvidenceRoot "disposable";New-Item -ItemType Directory -Force -Path $disposableRoot|Out-Null
$runId="m12-prelive-$($candidate_head.Substring(0,12))";& "C:\Program Files\nodejs\node.exe" (Join-Path $Root "scripts\qualify-m12-disposable-b5.mjs") --run-id $runId --port 25150 --output-root $disposableRoot *> (Join-Path $EvidenceRoot "disposable-b5.log");if($LASTEXITCODE -ne 0){throw "M12_PRELIVE_DISPOSABLE_B5_FAILED"}
$disposable=Get-Content -Raw -LiteralPath (Join-Path $disposableRoot "m12-disposable-b5-result.json")|ConvertFrom-Json
if(-not [bool]$disposable.normalized.allPatternsPassed -or -not [bool]$disposable.normalized.zeroOwnedResidue -or [bool]$disposable.normalized.authorityExpanded -or -not [bool]$disposable.normalized.exactToolSurface){throw "M12_PRELIVE_DISPOSABLE_B5_NOT_QUALIFIED"}
if([bool]$disposable.authority.s2Enabled -or [bool]$disposable.authority.genericExec -or [bool]$disposable.authority.genericShell){throw "M12_PRELIVE_AUTHORITY_EXPANDED"};$destructive="LOCKED"
$canary_head_after=(& git.exe -C $CanaryRoot rev-parse HEAD).Trim();$canary_status_after=(@(& git.exe -C $CanaryRoot status --porcelain)-join "`n");if($canary_head_after -ne $canary_head_before -or $canary_status_after -ne $canary_status_before){throw "M12_PRELIVE_CANARY_MUTATION_DETECTED"}
$m11TaskAfter=Get-ScheduledTask -TaskName $M11Task -ErrorAction SilentlyContinue;if(-not $m11TaskAfter -or [string]$m11TaskAfter.State -ne 'Running'){throw "M12_PRELIVE_M11_PRESERVATION_FAILED"};$m11ActionAfter=@($m11TaskAfter.Actions)[0];if([string]$m11ActionAfter.Execute -ne [string]$m11Action.Execute -or [string]$m11ActionAfter.Arguments -ne [string]$m11Action.Arguments){throw "M12_PRELIVE_M11_ACTION_DRIFT"}
if((Get-ContainerDigest $DedicatedTunnel) -ne $dedicatedBefore -or (Get-ContainerDigest $SharedTunnel) -ne $sharedBefore){throw "M12_PRELIVE_TUNNEL_MUTATION_DETECTED"};if((@(Get-ListenerIdentity 8768)-join ',') -ne ($listener8768Before-join ',')){throw "M12_PRELIVE_8768_MUTATION_DETECTED"}
$activationMembers=[ordered]@{preflight_m12_sha256=Get-Sha256 (Join-Path $Root "scripts\preflight-m12-b5-activation.ps1");executor_sha256=Get-Sha256 (Join-Path $Root "scripts\execute-m12-b5-activation.ps1");rollback_sha256=Get-Sha256 (Join-Path $Root "scripts\rollback-m12-b5-to-m11.ps1");probe_sha256=Get-Sha256 (Join-Path $Root "scripts\probe-m12-b5-host.mjs");state_verifier_sha256=Get-Sha256 (Join-Path $Root "scripts\verify-m12-preserved-state.mjs")}
$summary=[ordered]@{schema="HAIOS_M12_PRELIVE_QUALIFICATION_R1";candidate_head=$candidate_head;candidate_manifest_sha256=$candidate_manifest_sha256;tracked_count=$tracked_count;source_clean=$true;m11_final_terminal=$M11FinalTerminal;m11_final_cert_sha256=$m11_final_cert_sha256;m11_certified_head=$M11CertifiedHead;m11_certified_manifest_sha256=$M11CertifiedManifest;verification=[ordered]@{full_regression="PASS";full_regression_log_sha256=$full_test_sha256;typecheck="PASS";typecheck_log_sha256=$typecheck_sha256;build="PASS";build_log_sha256=$build_sha256;diff_check="PASS";diff_check_log_sha256=$diff_check_sha256;parser="PASS";secret_scan="PASS"};disposable_b5=[ordered]@{allPatternsPassed=[bool]$disposable.normalized.allPatternsPassed;zeroOwnedResidue=[bool]$disposable.normalized.zeroOwnedResidue;authorityExpanded=[bool]$disposable.normalized.authorityExpanded;exactToolSurface=[bool]$disposable.normalized.exactToolSurface;s2Enabled=[bool]$disposable.authority.s2Enabled;genericExec=[bool]$disposable.authority.genericExec;genericShell=[bool]$disposable.authority.genericShell;destructive=$destructive};canary_head_before=$canary_head_before;canary_head_after=$canary_head_after;canary_status_before=$canary_status_before;canary_status_after=$canary_status_after;m11_preserved=$true;listener_8768_before=$listener8768Before;listener_8769_before=$listener8769Before;activation_members=$activationMembers;required_human_decision=$NextDecision;terminal=$Terminal}
Write-JsonNoBom (Join-Path $EvidenceRoot "m12-prelive-qualification.json") $summary
$handoff=[ordered]@{candidate_head=$candidate_head;candidate_manifest_sha256=$candidate_manifest_sha256;qualification_path=Join-Path $EvidenceRoot "m12-prelive-qualification.json";qualification_sha256=Get-Sha256 (Join-Path $EvidenceRoot "m12-prelive-qualification.json");disposable_result_path=Join-Path $disposableRoot "m12-disposable-b5-result.json";disposable_result_sha256=Get-Sha256 (Join-Path $disposableRoot "m12-disposable-b5-result.json");secret_scan_path=Join-Path $EvidenceRoot "secret-scan.json";secret_scan_sha256=Get-Sha256 (Join-Path $EvidenceRoot "secret-scan.json");activation_members=$activationMembers;terminal=$Terminal};Write-JsonNoBom (Join-Path $EvidenceRoot "independent-review-handoff.json") $handoff
Write-Host "M12_PRELIVE=PASS";Write-Host "TERMINAL=$Terminal";Write-Host "REQUIRED_HUMAN_DECISION=$NextDecision"