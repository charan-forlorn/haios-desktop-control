import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const files = await new Promise((resolveFiles, reject) => {
  execFile("git", ["-C", root, "ls-files", "-z"], { encoding: "buffer", windowsHide: true }, (error, stdout) => {
    if (error !== null) reject(new Error("B6_MANIFEST_GIT_LIST_FAILED"));
    else resolveFiles(stdout.toString("utf8").split("\0").filter(Boolean).sort());
  });
});
const entries = [];
for (const file of files) {
  const path = relative(root, join(root, file)).replaceAll("\\", "/");
  const bytes = await readFile(join(root, file));
  entries.push({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
}
const canonical = `${entries.map(({ path, sha256 }) => `${sha256}  ${path}`).join("\n")}\n`;
const manifestSha256 = createHash("sha256").update(canonical, "utf8").digest("hex");
process.stdout.write(`${JSON.stringify({ schema: "HAIOS_B6_SOURCE_MANIFEST_R1", trackedCount: entries.length, manifestSha256, entries })}\n`);
