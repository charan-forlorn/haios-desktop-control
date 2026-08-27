import { classifyGatewayTool } from "./capabilities.js";

export type ToolAuthorizationDecision = "ALLOW" | "DENY";

export function authorizeTool(name: string): ToolAuthorizationDecision {
  return classifyGatewayTool(name) === "READ" ? "ALLOW" : "DENY";
}
