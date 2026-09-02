import type { Page } from "playwright";
import type { AuditLog } from "../lib/audit.js";
import type { EventConfig } from "../lib/types.js";
import { assertExpectedEvent } from "./common.js";

export async function runMockFlow(
  page: Page,
  config: EventConfig,
  audit: AuditLog,
  execute: boolean
): Promise<"ready" | "reserved"> {
  await page.goto(config.eventUrl, { waitUntil: "domcontentloaded" });
  await assertExpectedEvent(page, config);
  await audit.record("verified-event", { title: config.expectedEventTitle });

  const ticket = page.getByTestId("ticket-name");
  await ticket.filter({ hasText: config.expectedTicketName }).waitFor({ state: "visible" });
  const reserve = page.getByRole("button", { name: "Reserve free ticket" });
  await reserve.waitFor({ state: "visible" });
  await audit.record("reservation-ready", { ticket: config.expectedTicketName });

  if (!execute) return "ready";

  await reserve.click();
  await page.getByText("Reservation confirmed", { exact: true }).waitFor();
  await audit.record("reservation-confirmed");
  return "reserved";
}
