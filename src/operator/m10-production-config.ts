import {
  validateHostOperatorLaunchConfig,
  type HostOperatorLaunchConfig,
} from "./host-runtime-config.js";

export const M10_PRODUCTION_PORT = 8769 as const;
export const M10_PREFLIGHT_PORT = 8774 as const;

function deny(): never {
  throw new Error("M10_PRODUCTION_CONFIG_DENIED");
}

export function validateM10ReadOnlyProductionConfig(value: unknown): HostOperatorLaunchConfig {
  let validated: HostOperatorLaunchConfig;
  try {
    validated = validateHostOperatorLaunchConfig(value);
  } catch (error) {
    if (error instanceof Error && /^M09_ACTIVE_SCOPE_/u.test(error.message)) deny();
    throw error;
  }

  if (
    validated.mode !== "READ_ONLY_EMERGENCY"
    || validated.port !== M10_PRODUCTION_PORT
    || Object.keys(validated.allowedProjects).length !== 0
    || "activationScope" in validated
  ) deny();

  return validated;
}
