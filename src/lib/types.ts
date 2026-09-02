export type Provider = "mock" | "posh";

export interface EventConfig {
  provider: Provider;
  eventUrl: string;
  expectedEventTitle: string;
  expectedTicketName: string;
  eventPasswordEnv?: string;
  ticketPasswordEnv?: string;
  releaseAt: string | null;
  organizerOwned: boolean;
  permissionConfirmed: boolean;
  maxRefreshes: number;
  refreshIntervalMs: number;
}

export interface CliOptions {
  configPath: string;
  execute: boolean;
  headed: boolean;
}

export interface AuditEvent {
  at: string;
  elapsedMs: number;
  action: string;
  detail?: Record<string, unknown>;
}
