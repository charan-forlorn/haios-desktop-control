import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, win32 } from "node:path";

const STATE_SCHEMA = "HAIOS_M12_DISPOSABLE_B5_STATE_R1";
const [stateArg, artifactArg] = process.argv.slice(2);

function deny(code) {
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}

if (typeof stateArg !== "string" || typeof artifactArg !== "string" || !isAbsolute(stateArg) || !isAbsolute(artifactArg)) {
  deny("M12_DISPOSABLE_FIXED_RUNNER_ARGS_DENIED");
} else {
  const statePath = resolve(stateArg);
  const artifactPath = resolve(artifactArg);
  const worktreeRoot = resolve(process.cwd());
  const relState = win32.relative(worktreeRoot, statePath);
  const relArtifact = win32.relative(worktreeRoot, artifactPath);
  const stateAllowed = relState === "fixture-state.json";
  const artifactAllowed = relArtifact === win32.join("coverage", "qualification-artifact.txt");
  if (!stateAllowed || !artifactAllowed) {
    deny("M12_DISPOSABLE_FIXED_RUNNER_PATH_DENIED");
  } else {
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
        || Object.getPrototypeOf(parsed) !== Object.prototype) throw new Error("shape");
      const keys = Object.keys(parsed).sort();
      const expected = ["artifactValue", "emitAllowedArtifact", "ready", "revision", "schema"].sort();
      if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("fields");
      if (parsed.schema !== STATE_SCHEMA || (parsed.ready !== "ready" && parsed.ready !== "broken")
        || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0 || parsed.revision > 100
        || typeof parsed.emitAllowedArtifact !== "boolean"
        || typeof parsed.artifactValue !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/u.test(parsed.artifactValue)) {
        throw new Error("values");
      }
      if (parsed.ready !== "ready") {
        deny("M12_DISPOSABLE_FIXED_RUNNER_ASSERTION_FAILED");
      } else {
        if (parsed.emitAllowedArtifact) {
          await mkdir(dirname(artifactPath), { recursive: true });
          await writeFile(artifactPath, `${parsed.artifactValue}\n`, "utf8");
        }
        process.stdout.write(`M12_DISPOSABLE_FIXED_RUNNER_PASS revision=${parsed.revision}\n`);
      }
    } catch (error) {
      if (process.exitCode === undefined) deny("M12_DISPOSABLE_FIXED_RUNNER_STATE_DENIED");
    }
  }
}
