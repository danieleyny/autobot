import type { Locator, Page } from "playwright";
import type { AuditLog } from "../lib/audit.js";
import type { EventConfig } from "../lib/types.js";

export async function assertExpectedEvent(page: Page, config: EventConfig): Promise<void> {
  const title = page.getByRole("heading", {
    name: config.expectedEventTitle,
    exact: true,
    level: 1
  });
  await title.waitFor({ state: "visible", timeout: 15_000 });
}

export async function findTicketRow(page: Page, ticketName: string): Promise<Locator> {
  const label = page.getByText(ticketName, { exact: true }).first();
  await label.waitFor({ state: "visible", timeout: 10_000 });
  return label.locator("xpath=ancestor-or-self::*[self::article or self::li or self::div][1]");
}

export async function clickFirstVisible(
  candidates: Locator[],
  audit: AuditLog,
  action: string,
  timeout = 2_000
): Promise<boolean> {
  for (const candidate of candidates) {
    try {
      const count = await candidate.count();
      if (count !== 1) continue;
      await candidate.waitFor({ state: "visible", timeout });
      await candidate.click();
      await audit.record(action);
      return true;
    } catch {
      // Try the next narrowly scoped, user-visible candidate.
    }
  }
  return false;
}
