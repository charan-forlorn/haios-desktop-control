import type { GatewayCapabilityClass } from "./capabilities.js";

export interface AuditEvent {
  readonly timestamp: string;
  readonly requestId: string;
  readonly tool: string;
  readonly capabilityClass: GatewayCapabilityClass;
  readonly targetScope?: string;
  readonly decision: "ALLOW" | "DENY";
  readonly resultClass: "SUCCESS" | "DENIED" | "ERROR" | "TRUNCATED";
  readonly durationMs: number;
}

export interface AuditSink {
  write(event: AuditEvent): void | Promise<void>;
}

export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];

  write(event: AuditEvent): void {
    this.events.push(Object.freeze({ ...event }));
  }
}

export const NOOP_AUDIT_SINK: AuditSink = Object.freeze({
  write: () => undefined,
});
