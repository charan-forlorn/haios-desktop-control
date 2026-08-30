import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
function deny() { throw new Error("B6_RUNTIME_PROCESS_NOT_CURRENT"); }
async function pwshJson(script) {
  let result;
  try {
    result = await run("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 });
  } catch { return deny(); }
  try { return JSON.parse(result.stdout.trim()); } catch { return deny(); }
}

export async function inspectProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return deny();
  const value = await pwshJson(`$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';if($null -eq $p){throw 'missing'};$gp=Get-Process -Id ${pid} -ErrorAction Stop;[pscustomobject]@{pid=[int]$p.ProcessId;creationTime=$gp.StartTime.ToUniversalTime().ToString('o');executablePath=[string]$p.ExecutablePath;commandLine=[string]$p.CommandLine}|ConvertTo-Json -Compress`);
  if (value?.pid !== pid || typeof value.creationTime !== "string" || !Number.isFinite(Date.parse(value.creationTime))
    || typeof value.executablePath !== "string" || value.executablePath.length === 0
    || typeof value.commandLine !== "string" || value.commandLine.length === 0) return deny();
  return Object.freeze({ processPid: pid, processCreationTime: value.creationTime,
    processExecutablePath: value.executablePath, processCommandLineSha256: sha256(value.commandLine) });
}

export async function assertAttestedListenerIdentity(attestation, port = 8769) {
  if (typeof attestation !== "object" || attestation === null || !Number.isSafeInteger(attestation.processPid) || attestation.processPid <= 0
    || typeof attestation.processCreationTime !== "string" || !Number.isFinite(Date.parse(attestation.processCreationTime))
    || typeof attestation.processExecutablePath !== "string" || attestation.processExecutablePath.length === 0
    || typeof attestation.processCommandLineSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(attestation.processCommandLineSha256)
    || !Number.isSafeInteger(port) || port < 1 || port > 65535) return deny();
  const live = await inspectProcessIdentity(attestation.processPid);
  if (live.processCreationTime !== attestation.processCreationTime
    || live.processExecutablePath.toLowerCase() !== attestation.processExecutablePath.toLowerCase()
    || live.processCommandLineSha256 !== attestation.processCommandLineSha256) return deny();
  const listener = await pwshJson(`$ErrorActionPreference='Stop';$owners=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop|Where-Object {$_.LocalAddress -eq '127.0.0.1'}|ForEach-Object {[int]$_.OwningProcess});[pscustomobject]@{owners=$owners}|ConvertTo-Json -Compress`);
  if (!Array.isArray(listener?.owners) || listener.owners.length !== 1 || listener.owners[0] !== attestation.processPid) return deny();
}