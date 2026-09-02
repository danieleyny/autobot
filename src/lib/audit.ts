import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AuditEvent } from "./types.js";

export class AuditLog {
  readonly directory: string;
  private readonly started = performance.now();
  private readonly logPath: string;

  constructor() {
    const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    this.directory = resolve("artifacts", stamp);
    this.logPath = resolve(this.directory, "audit.jsonl");
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.logPath, "", "utf8");
  }

  async record(action: string, detail?: Record<string, unknown>): Promise<void> {
    const event: AuditEvent = {
      at: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - this.started),
      action,
      detail
    };
    await appendFile(this.logPath, `${JSON.stringify(event)}\n`, "utf8");
    console.log(`[${event.elapsedMs}ms] ${action}`, detail ?? "");
  }
}
