param(
  [Parameter(Mandatory=$true)][string]$EvidenceRoot,
  [ValidateSet("Inspect","Fixture")][string]$Mode = "Inspect"
)
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
if ($PSVersionTable.PSVersion.Major -lt 7) { throw "POWERSHELL_7_REQUIRED" }
$Root = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$EvidenceRoot = [IO.Path]::GetFullPath((Join-Path $Root $EvidenceRoot))
New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null

$OperatorCompose = "C:\Workspace\haios-operator-mcp\docker-compose.operator.yml"
$DedicatedCompose = "C:\Workspace\haios-operator-mcp\docker-compose.operator-dedicated-tunnel.yml"
$TaskName = "HAIOS-M10-Operator-ReadOnly"
$Containers = @("haios-operator-mcp","haios-operator-dedicated-tunnel-client","haios-tunnel-client")

function Get-Sha256([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }
function Write-JsonNoBom([string]$Path, $Object) {
  [IO.File]::WriteAllText($Path, (($Object | ConvertTo-Json -Depth 12) + "`n"), [Text.UTF8Encoding]::new($false))
}
function Get-ListenerIdentity([int]$PortNumber) {
  @((Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue |
    Sort-Object LocalAddress,OwningProcess | ForEach-Object { "$($_.LocalAddress)|$($_.LocalPort)|$($_.OwningProcess)" }))
}
function Get-ContainerIntegrityDigest([string]$Name) {
  $Raw = & docker.exe inspect $Name 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $Raw) { throw "M10_CONTAINER_UNAVAILABLE:$Name" }
  $Object = ($Raw | ConvertFrom-Json)[0]
  $Networks = @($Object.NetworkSettings.Networks.PSObject.Properties | Sort-Object Name | ForEach-Object {
    [ordered]@{ name=$_.Name; network_id=$_.Value.NetworkID; endpoint_id=$_.Value.EndpointID; ip=$_.Value.IPAddress; gateway=$_.Value.Gateway }
  })
  $Mounts = @($Object.Mounts | Sort-Object Destination,Type | ForEach-Object {
    [ordered]@{ type=$_.Type; destination=$_.Destination; mode=$_.Mode; rw=$_.RW; propagation=$_.Propagation }
  })
  $Snapshot = [ordered]@{
    id=$Object.Id; created=$Object.Created; image_id=$Object.Image; config_image=$Object.Config.Image
    path=$Object.Path; args=@($Object.Args); network_mode=$Object.HostConfig.NetworkMode
    restart_policy=$Object.HostConfig.RestartPolicy; mounts=$Mounts; networks=$Networks
  }
  $Bytes = [Text.Encoding]::UTF8.GetBytes(($Snapshot | ConvertTo-Json -Depth 8 -Compress))
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}

function Get-ProductionSnapshot {
  $containerDigests = @($Containers | ForEach-Object { [ordered]@{ name=$_; sha256=(Get-ContainerIntegrityDigest $_) } })
  [ordered]@{
    operator_compose_sha256=Get-Sha256 $OperatorCompose
    dedicated_compose_sha256=Get-Sha256 $DedicatedCompose
    containers=$containerDigests
    listener_8768=@(Get-ListenerIdentity 8768)
    listener_8769=@(Get-ListenerIdentity 8769)
    scheduled_task_present=[bool](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
  }
}
function Test-AclFixture {
  $FixtureRoot = Join-Path $EvidenceRoot "acl-fixture"
  Remove-Item -LiteralPath $FixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $FixtureRoot | Out-Null
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $security = [Security.AccessControl.DirectorySecurity]::new()
  $security.SetAccessRuleProtection($true, $false)
  $inherit = [Security.AccessControl.InheritanceFlags]"ContainerInherit,ObjectInherit"
  $prop = [Security.AccessControl.PropagationFlags]::None
  $allow = [Security.AccessControl.AccessControlType]::Allow
  # WellKnownSidType.WorldSid and WellKnownSidType.BuiltinUsersSid are forbidden broad principals.
  $worldSid = [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::WorldSid, $null)
  $usersSid = [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::BuiltinUsersSid, $null)
  # Required principals: WellKnownSidType.LocalSystemSid and WellKnownSidType.BuiltinAdministratorsSid.
  $systemSid = [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
  $adminsSid = [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
  foreach ($sid in @($identity.User,$systemSid,$adminsSid)) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,$prop,$allow)
    $security.AddAccessRule($rule) | Out-Null
  }
  Set-Acl -LiteralPath $FixtureRoot -AclObject $security
  $acl = Get-Acl -LiteralPath $FixtureRoot
  $sids = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value })
  $result = [ordered]@{ inherited_protected=$acl.AreAccessRulesProtected; current_operator_present=$sids -contains $identity.User.Value; system_present=$sids -contains $systemSid.Value; administrators_present=$sids -contains $adminsSid.Value; world_absent=$sids -notcontains $worldSid.Value; builtin_users_absent=$sids -notcontains $usersSid.Value }
  Remove-Item -LiteralPath $FixtureRoot -Recurse -Force
  if (Test-Path -LiteralPath $FixtureRoot) { throw "M10_ACL_FIXTURE_RESIDUE" }
  return $result
}
function Test-TaskSchedulerFeasibility {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $node = "C:\Program Files\nodejs\node.exe"
  $supervisor = "C:\Workspace\haios-desktop-control-runtime\scripts\run-m10-readonly-supervisor.mjs"
  $config = Join-Path $env:LOCALAPPDATA "HAIOS\M10\host-config.json"
  $action = New-ScheduledTaskAction -Execute $node -Argument "`"$supervisor`" `"$config`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
  $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
  [ordered]@{
    task_name=$TaskName; current_user=$identity; task_registered=$false
    logon_type=[string]$task.Principal.LogonType
    run_level=[string]$task.Principal.RunLevel
    action_execute=[string]$task.Actions.Execute
    action_argument=[string]$task.Actions.Arguments
    supervisor_bound=([string]$task.Actions.Arguments).Contains($supervisor)
    trigger_user=[string]$task.Triggers.UserId
    restart_count=[int]$task.Settings.RestartCount
    no_password_stored=$true
  }
}

function Invoke-ComposeRender {
  $OperatorOverride = Join-Path $EvidenceRoot "operator-preflight.override.yml"
  $DedicatedOverride = Join-Path $EvidenceRoot "dedicated-preflight.override.yml"
  @'
services:
  operator-mcp:
    ports: !reset []
'@ | Set-Content -LiteralPath $OperatorOverride -Encoding utf8NoBOM
  @'
services:
  operator-dedicated-tunnel-client:
    volumes:
      - type: bind
        source: C:/HAIOS/M10/placeholder/operator-api-key
        target: /run/secrets/m10-operator-api-key
        read_only: true
    environment:
      MCP_EXTRA_HEADERS: "X-API-Key: file:/run/secrets/m10-operator-api-key"
    command: !override
      - "--control-plane.api-key=file:/run/secrets/control-plane-api-key"
      - "--control-plane.tunnel-id=tunnel_22222222222222222222222222222222"
      - "--mcp.server-url=url=http://host.docker.internal:8769/mcp,channel=main"
      - "--health.listen-addr=127.0.0.1:8079"
'@ | Set-Content -LiteralPath $DedicatedOverride -Encoding utf8NoBOM
  $env:HAIOS_OPERATOR_TUNNEL_RUNTIME_KEY_FILE = "C:/HAIOS/M10/placeholder/control-plane-key"
  $operatorRendered = & docker.exe compose -f $OperatorCompose -f $OperatorOverride config --format json
  if ($LASTEXITCODE -ne 0) { throw "M10_OPERATOR_COMPOSE_RENDER_FAILED" }
  $dedicatedRendered = & docker.exe compose -f $DedicatedCompose -f $DedicatedOverride config --format json
  if ($LASTEXITCODE -ne 0) { throw "M10_DEDICATED_COMPOSE_RENDER_FAILED" }
  $operatorObject = $operatorRendered | ConvertFrom-Json
  $dedicatedObject = $dedicatedRendered | ConvertFrom-Json
  $operatorPorts = @($operatorObject.services.'operator-mcp'.ports | Where-Object { $null -ne $_ })
  $dedicatedService = $dedicatedObject.services.'operator-dedicated-tunnel-client'
  $dedicatedJson = $dedicatedService | ConvertTo-Json -Depth 12 -Compress
  Remove-Item Env:HAIOS_OPERATOR_TUNNEL_RUNTIME_KEY_FILE -ErrorAction SilentlyContinue
  [ordered]@{
    operator_host_port_removed=($operatorPorts.Count -eq 0)
    operator_service_present=($null -ne $operatorObject.services.'operator-mcp')
    dedicated_service_present=($null -ne $dedicatedService)
    dedicated_target_host_runtime=$dedicatedJson.Contains("host.docker.internal:8769/mcp")
    dedicated_api_key_mount=$dedicatedJson.Contains("/run/secrets/m10-operator-api-key")
    dedicated_file_backed_header=$dedicatedJson.Contains("X-API-Key: file:/run/secrets/m10-operator-api-key")
    shared_tunnel_compose_touched=$false
  }
}

$Pre = Get-ProductionSnapshot
Write-JsonNoBom (Join-Path $EvidenceRoot "production-preimage.json") $Pre
$Task = Test-TaskSchedulerFeasibility
Write-JsonNoBom (Join-Path $EvidenceRoot "task-scheduler-feasibility.json") $Task
$Compose = Invoke-ComposeRender
Write-JsonNoBom (Join-Path $EvidenceRoot "compose-render-result.json") $Compose

if ($Mode -eq "Fixture") {
  $Acl = Test-AclFixture
  Write-JsonNoBom (Join-Path $EvidenceRoot "acl-fixture-result.json") $Acl
} else {
  $Acl = [ordered]@{ executed=$false }
}

$Post = Get-ProductionSnapshot
if (($Pre | ConvertTo-Json -Depth 12 -Compress) -ne ($Post | ConvertTo-Json -Depth 12 -Compress)) {
  throw "M10_PRODUCTION_STATE_CHANGED_DURING_PREFLIGHT"
}
if (-not $Compose.operator_host_port_removed -or -not $Compose.dedicated_target_host_runtime -or -not $Compose.dedicated_api_key_mount -or -not $Compose.dedicated_file_backed_header) { throw "M10_COMPOSE_RENDER_CONTRACT_FAILED" }
if ($Mode -eq "Fixture" -and (-not $Acl.inherited_protected -or -not $Acl.current_operator_present -or -not $Acl.system_present -or -not $Acl.administrators_present -or -not $Acl.world_absent -or -not $Acl.builtin_users_absent)) { throw "M10_ACL_FIXTURE_FAILED" }
Write-Host "M10_PREFLIGHT=PASS"
Write-Host "PRODUCTION_STATE_UNCHANGED=PASS"
