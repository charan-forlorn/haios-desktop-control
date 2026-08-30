const endpoint = "http://127.0.0.1:8769/mcp";
const expectedStage = process.argv[2];
if (expectedStage !== "SKILL_FABRIC" && expectedStage !== "HERMES_OS") throw new Error("B6_PROBE_STAGE_REQUIRED");
const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
  jsonrpc: "2.0", id: "b6-probe", method: "tools/call", params: { name: "operator_status", arguments: {} },
}) });
if (!response.ok) throw new Error("B6_HOST_PROBE_FAILED");
const result = await response.json();
if (result?.result?.mode !== "ACTIVE" || result?.result?.protocol !== "operator13" || result?.result?.mutation_active !== true
  || result?.result?.s2_enabled !== false || result?.result?.generic_exec !== false || result?.result?.generic_shell !== false
  || result?.result?.destructive !== "LOCKED") throw new Error("B6_HOST_CAPABILITY_DRIFT");
process.stdout.write(`${JSON.stringify({ endpoint, stage: expectedStage, verified: true })}\n`);
