import {
  classifyGatewayTool,
  type GatewayCapabilityClass,
} from "./capabilities.js";

export type ToolAuthorizationDecision = "ALLOW" | "DENY";
export type AuthorizableCapabilityClass = Exclude<GatewayCapabilityClass, "UNKNOWN">;

export function authorizeTool(
  name: string,
  requiredClass: AuthorizableCapabilityClass = "READ",
): ToolAuthorizationDecision {
  return classifyGatewayTool(name) === requiredClass ? "ALLOW" : "DENY";
}
