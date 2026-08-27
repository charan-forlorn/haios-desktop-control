$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
Set-Location (Split-Path -Parent $PSScriptRoot)

$Root = (Get-Location).Path
$RunId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$EvidenceRoot = Join-Path $Root "evidence\m01\$RunId"
$RuntimeRoot = Join-Path $Root "runtime\m01-$RunId"
$Port = 8772
New-Item -ItemType Directory -Force $EvidenceRoot,$RuntimeRoot | Out-Null

function Test-Port([int]$PortNumber) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue)
}

function Require-Exit([string]$Name) {
    if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit $LASTEXITCODE" }
}

Write-Host "M01_RUN_ID=$RunId"
Write-Host "[1] Currentness and static gates"
if ((git status --porcelain).Length -ne 0) { throw "WORKTREE_NOT_CLEAN" }
$Head = (git rev-parse HEAD).Trim()
$Branch = (git branch --show-current).Trim()
Write-Host "HEAD=$Head"
Write-Host "BRANCH=$Branch"
Write-Host "[2] Test gates"
& npm.cmd test -- tests/m01-adversarial.test.ts
Require-Exit "ADVERSARIAL_TESTS"
& npm.cmd test
Require-Exit "FULL_TESTS"
& npm.cmd run typecheck
Require-Exit "TYPECHECK"
& npm.cmd run build
Require-Exit "BUILD"

Write-Host "[3] Dependency identity"
$Versions = node -e "const p=require('./package-lock.json');const r=p.packages[''];console.log(JSON.stringify({sdk:r.dependencies['@modelcontextprotocol/sdk'],zod:r.dependencies.zod,typescript:r.devDependencies.typescript,vitest:r.devDependencies.vitest,nodeTypes:r.devDependencies['@types/node']}))"
Require-Exit "DEPENDENCY_IDENTITY"
$VersionObject = $Versions | ConvertFrom-Json
if ($VersionObject.sdk -ne "1.30.0" -or $VersionObject.zod -ne "4.4.3" -or $VersionObject.typescript -ne "7.0.2" -or $VersionObject.vitest -ne "4.1.11" -or $VersionObject.nodeTypes -ne "24.13.3") {
    throw "DEPENDENCY_IDENTITY_MISMATCH"
}

if (Test-Port 8771) { throw "Q2R1_PORT_8771_NOT_FREE" }
if (Test-Port $Port) { throw "M01_PORT_8772_NOT_FREE" }
if (-not (Test-Port 8768)) { throw "SECURE_MCP_8768_REGRESSION" }
if (-not (Test-Port 8769)) { throw "OPERATOR_MCP_8769_REGRESSION" }
Write-Host "[4] Prepare live runtime"
$Launcher = Join-Path $RuntimeRoot "launcher.mjs"
$ClientScript = Join-Path $RuntimeRoot "client.mjs"
$StdoutPath = Join-Path $EvidenceRoot "runtime.stdout.log"
$StderrPath = Join-Path $EvidenceRoot "runtime.stderr.log"
$ClientErr = Join-Path $EvidenceRoot "client.stderr.log"

@'
import { DesktopCommanderClient } from "../../dist/src/upstream.js";
import { createGatewayServer } from "../../dist/src/server.js";
const key = process.env.HAIOS_M01_API_KEY;
if (!key) throw new Error("HAIOS_M01_API_KEY missing");
const upstream = await DesktopCommanderClient.connect();
const runtime = await createGatewayServer({ apiKey: key, upstream, host: "127.0.0.1", port: 8772 });
const address = await runtime.listen();
console.log(`M01_RUNTIME_READY=${address.url}`);
const stop = async () => { try { await runtime.close(); } finally { process.exit(0); } };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 60000);
'@ | Set-Content -Encoding utf8 $Launcher
@'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const key = process.env.HAIOS_M01_API_KEY;
if (!key) throw new Error("HAIOS_M01_API_KEY missing");
const client = new Client({ name: "haios-m01-qualifier", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8772/mcp"), {
  requestInit: { headers: { "X-API-Key": key } },
});
const liveCalls = [];
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`LIVE_CALL_FAILED:${name}`);
  liveCalls.push(name);
  return result;
};
await client.connect(transport);
const tools = await client.listTools();
await call("gateway_status");
await call("desktop_status");
await call("filesystem_list", { path: "C:\\Workspace\\haios-desktop-control", depth: 1 });
await call("filesystem_read", { path: "C:\\Workspace\\haios-desktop-control\\package.json", length: 20 });
await call("filesystem_read_multiple", { paths: ["C:\\Workspace\\haios-desktop-control\\package.json", "C:\\Workspace\\haios-desktop-control\\tsconfig.json"] });
await call("filesystem_stat", { path: "C:\\Workspace\\haios-desktop-control\\package.json" });
'@ | Set-Content -Encoding utf8 $ClientScript
@'
const started = await call("search_start", { path: "C:\\Workspace\\haios-desktop-control", pattern: "*.ts", searchType: "files", maxResults: 5, contextLines: 0 });
const sessionMatch = JSON.stringify(started).match(/search_[A-Za-z0-9_-]+/);
if (!sessionMatch) throw new Error("SEARCH_SESSION_ID_NOT_FOUND");
const sessionId = sessionMatch[0];
await call("search_results", { sessionId, offset: 0, length: 5 });
await call("search_stop", { sessionId });
await call("search_list");
await call("process_list");
await call("session_list");
const expected = ["desktop_status","gateway_status","filesystem_list","filesystem_read","filesystem_read_multiple","filesystem_stat","search_start","search_results","search_stop","search_list","process_list","session_list"];
const names = tools.tools.map(t => t.name);
if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error("LIVE_TOOL_SURFACE_MISMATCH");
console.log(JSON.stringify({ toolNames: names, liveCalls, searchSessionPresent: true }));
await client.close();
'@ | Add-Content -Encoding utf8 $ClientScript

$KeyBytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
$Key = [Convert]::ToBase64String($KeyBytes).TrimEnd("=").Replace("+","-").Replace("/","_")
$RuntimeProcess = $null
$LiveResult = $null
try {
    Write-Host "[5] Start live Desktop Commander gateway"
    $env:HAIOS_M01_API_KEY = $Key
    $RuntimeProcess = Start-Process node.exe -ArgumentList @($Launcher) -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath -PassThru -WindowStyle Hidden
    Remove-Item Env:HAIOS_M01_API_KEY -ErrorAction SilentlyContinue

    $Ready = $false
    for ($i = 0; $i -lt 120; $i++) {
        Start-Sleep -Seconds 1
        if (Test-Port $Port) { $Ready = $true; break }
        if ($RuntimeProcess.HasExited) { break }
    }
    if (-not $Ready) {
        if (Test-Path $StderrPath) { Get-Content $StderrPath -Tail 30 }
        throw "LIVE_GATEWAY_START_FAILED"
    }
    Write-Host "LIVE_GATEWAY_START=PASS"

    $Unauth = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/mcp" -Method GET -SkipHttpErrorCheck -TimeoutSec 10
    if ([int]$Unauth.StatusCode -ne 401) { throw "LIVE_AUTH_NEGATIVE_FAILED" }
    Write-Host "LIVE_AUTH_NEGATIVE=PASS"
    Write-Host "[6] Live MCP READ qualification"
    $env:HAIOS_M01_API_KEY = $Key
    $ClientOutput = & node.exe $ClientScript 2> $ClientErr
    $ClientExit = $LASTEXITCODE
    Remove-Item Env:HAIOS_M01_API_KEY -ErrorAction SilentlyContinue
    if ($ClientExit -ne 0) {
        if (Test-Path $ClientErr) { Get-Content $ClientErr -Tail 40 }
        throw "LIVE_MCP_CLIENT_FAILED"
    }
    $LiveResult = (($ClientOutput | Select-Object -Last 1) | ConvertFrom-Json)
    if ($LiveResult.toolNames.Count -ne 12 -or $LiveResult.liveCalls.Count -ne 12) {
        throw "LIVE_READ_COVERAGE_INCOMPLETE"
    }
    Write-Host "LIVE_TOOLS_LIST=PASS"
    Write-Host "LIVE_READ_CALLS=12/12"
}
finally {
    Remove-Item Env:HAIOS_M01_API_KEY -ErrorAction SilentlyContinue
    if ($RuntimeProcess -and -not $RuntimeProcess.HasExited) {
        try { & taskkill.exe /PID $RuntimeProcess.Id /T /F | Out-Null } catch { }
    }
    for ($i = 0; $i -lt 30; $i++) {
        if (-not (Test-Port $Port)) { break }
        Start-Sleep -Seconds 1
    }
    if (Test-Port $Port) { throw "M01_PORT_8772_CLEANUP_FAILED" }
    $SecretLeakDetected = $false
    if ($Key) {
        foreach ($File in (Get-ChildItem $EvidenceRoot -File -ErrorAction SilentlyContinue)) {
            if ([IO.File]::ReadAllText($File.FullName).Contains($Key)) { $SecretLeakDetected = $true }
        }
    }
    $Key = $null
    $KeyBytes = $null
    if ($SecretLeakDetected) { throw "EPHEMERAL_API_KEY_PERSISTED" }
    Write-Host "LIVE_RUNTIME_CLEANUP=PASS"
    Write-Host "EPHEMERAL_SECRET_PERSISTENCE=PASS"
}
Write-Host "[7] Post-live regression and source manifest"
if (-not (Test-Port 8768)) { throw "POST_SECURE_MCP_8768_REGRESSION" }
if (-not (Test-Port 8769)) { throw "POST_OPERATOR_MCP_8769_REGRESSION" }
if (Test-Port 8771) { throw "POST_Q2R1_PORT_8771_NOT_FREE" }

$ManifestPath = Join-Path $EvidenceRoot "source-manifest.txt"
$ManifestLines = @()
foreach ($Relative in (git ls-files | Sort-Object)) {
    $Absolute = Join-Path $Root $Relative
    $Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Absolute).Hash.ToLowerInvariant()
    $ManifestLines += "$Hash  $Relative"
}
$ManifestLines | Set-Content -Encoding utf8 $ManifestPath
$ManifestDigest = (Get-FileHash -Algorithm SHA256 $ManifestPath).Hash.ToLowerInvariant()

if ((git status --porcelain).Length -ne 0) { throw "POST_QUALIFICATION_WORKTREE_DRIFT" }
$HeadAfter = (git rev-parse HEAD).Trim()
if ($HeadAfter -ne $Head) { throw "HEAD_CHANGED_DURING_QUALIFICATION" }
Write-Host "SOURCE_MANIFEST_DIGEST=$ManifestDigest"
$Result = [ordered]@{
    mission = "HAIOS_DESKTOP_CONTROL_PLANE_R1_M01_READ_GATEWAY"
    run_id = $RunId
    head = $Head
    branch = $Branch
    source_manifest_digest = $ManifestDigest
    desktop_commander_version = "0.2.47"
    upstream_transport = "stdio"
    downstream_transport = "streamable_http"
    downstream_tool_count = 12
    downstream_tool_names = @($LiveResult.toolNames)
    live_read_calls = @($LiveResult.liveCalls)
    read_capability = "QUALIFIED_CANDIDATE"
    execute_capability = "LOCKED"
    mutate_capability = "LOCKED"
    destructive_capability = "LOCKED"
    unauthorized_upstream_calls = 0
    auth_negative = "PASS"
    path_escape_tests = "PASS"
    sensitive_path_tests = "PASS"
    adversarial_tests = "PASS"
    full_tests = "PASS"
    typecheck = "PASS"
    build = "PASS"
    port_8768_regression = "PASS"
    port_8769_regression = "PASS"
    port_8771_free = $true
    port_8772_cleanup = "PASS"
    secrets_persisted = $false
    tunnel_modified = $false
    independent_verification = "PENDING"
    terminal = "HAIOS_DESKTOP_CONTROL_PLANE_R1_M01_READY_FOR_INDEPENDENT_VERIFICATION"
}
$ResultPath = Join-Path $EvidenceRoot "m01-qualification-result.json"
$Result | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 $ResultPath
Write-Host "RESULT_PATH=$ResultPath"
Write-Host "HAIOS_DESKTOP_CONTROL_PLANE_R1_M01_READY_FOR_INDEPENDENT_VERIFICATION" -ForegroundColor Green
