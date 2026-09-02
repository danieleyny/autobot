import type { Locator, Page } from "playwright";
import type { AuditLog } from "../lib/audit.js";
import type { EventConfig } from "../lib/types.js";
import { assertExpectedEvent, clickFirstVisible } from "./common.js";

const FREE_PATTERN = /\b(free|rsvp|\$0(?:\.00)?)\b/i;

export async function unlockPoshEventIfNeeded(
  page: Page,
  config: EventConfig,
  audit: AuditLog
): Promise<void> {
  const passwordInput = page.getByPlaceholder("Password", { exact: true });
  const eventHeading = page.getByRole("heading", {
    name: config.expectedEventTitle,
    exact: true,
    level: 1
  });

  await Promise.race([
    passwordInput.waitFor({ state: "visible", timeout: 10_000 }),
    eventHeading.waitFor({ state: "visible", timeout: 10_000 })
  ]).catch(() => {});
  if (await eventHeading.isVisible().catch(() => false)) return;
  if (!(await passwordInput.isVisible().catch(() => false))) {
    throw new Error("Neither the event password gate nor the expected event heading appeared.");
  }

  const environmentName = config.eventPasswordEnv ?? "POSH_EVENT_PASSWORD";
  const password = process.env[environmentName];
  if (!password) {
    throw new Error(
      `This event is password-protected. Set ${environmentName} for this terminal session and retry.`
    );
  }

  const submitCandidates = [
    page.locator('button[type="submit"]'),
    passwordInput.locator("xpath=ancestor::form[1]").getByRole("button")
  ];
  let submit: Locator | null = null;
  for (const candidate of submitCandidates) {
    if ((await candidate.count()) === 1) {
      submit = candidate;
      break;
    }
  }
  if (!submit) {
    throw new Error("Could not uniquely identify the event password-submit button.");
  }

  await passwordInput.fill(password);
  await passwordInput.press("Enter");
  try {
    await eventHeading.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    await submit.click();
    await eventHeading.waitFor({ state: "visible", timeout: 10_000 });
  }
  await audit.record("event-password-accepted", {
    source: environmentName,
    note: "The password value was not logged or stored."
  });
}

async function unlockHiddenTicketsIfNeeded(
  page: Page,
  config: EventConfig,
  audit: AuditLog
): Promise<void> {
  const ticket = page.getByText(config.expectedTicketName, { exact: true });
  if (await ticket.isVisible().catch(() => false)) return;

  const unlockInput = page.getByRole("textbox", {
    name: "Unlock hidden tickets",
    exact: true
  });
  if (!(await unlockInput.isVisible().catch(() => false))) return;

  const environmentName = config.ticketPasswordEnv ?? "POSH_TICKET_PASSWORD";
  const password = process.env[environmentName];
  if (!password) {
    throw new Error(
      `The selected ticket is hidden. Set ${environmentName} for this terminal session and retry.`
    );
  }

  const unlockButton = page.getByRole("button", { name: "Unlock", exact: true });
  const unlockCount = await unlockButton.count();
  if (unlockCount !== 1) {
    throw new Error(`Expected one hidden-ticket Unlock button, found ${unlockCount}.`);
  }

  await unlockInput.fill(password);
  await unlockButton.click();
  await ticket.waitFor({ state: "visible", timeout: 10_000 });
  await audit.record("hidden-ticket-unlocked", {
    ticket: config.expectedTicketName,
    source: environmentName,
    note: "The password value was not logged or stored."
  });
}

export async function runPoshFlow(
  page: Page,
  config: EventConfig,
  audit: AuditLog,
  execute: boolean
): Promise<"ready" | "reserved"> {
  await page.goto(config.eventUrl, { waitUntil: "domcontentloaded" });
  await unlockPoshEventIfNeeded(page, config, audit);
  await assertExpectedEvent(page, config);
  await audit.record("verified-event", { title: config.expectedEventTitle });

  await clickFirstVisible(
    [
      page.getByRole("button", { name: "Get Tickets", exact: true }),
      page.getByRole("button", { name: /rsvp/i }),
      page.getByRole("button", { name: /reserve/i })
    ],
    audit,
    "opened-ticket-picker"
  );

  await unlockHiddenTicketsIfNeeded(page, config, audit);
  const ticketHeading = page.getByRole("heading", {
    name: config.expectedTicketName,
    exact: true
  });
  const ticketHeadingCount = await ticketHeading.count();
  if (ticketHeadingCount !== 1) {
    throw new Error(
      `Expected one "${config.expectedTicketName}" ticket heading, found ${ticketHeadingCount}.`
    );
  }
  const ticketRow = ticketHeading.locator(
    'xpath=ancestor::div[@data-sentry-component="EventPageTicketItem"]'
  );
  const ticketRowCount = await ticketRow.count();
  if (ticketRowCount !== 1) {
    throw new Error(`Expected one matching POSH ticket card, found ${ticketRowCount}.`);
  }
  const rowText = await ticketRow.innerText();
  if (!FREE_PATTERN.test(rowText)) {
    throw new Error("Safety stop: the selected ticket is not visibly marked free/RSVP/$0.");
  }

  await audit.record("verified-free-ticket", {
    ticket: config.expectedTicketName,
    visibleText: rowText.slice(0, 250)
  });

  if (!execute) {
    await audit.record("dry-run-complete", {
      note: "No quantity or checkout control was clicked."
    });
    return "ready";
  }

  const added = await clickFirstVisible(
    [ticketRow.getByRole("button")],
    audit,
    "selected-one-ticket"
  );
  if (!added) throw new Error("Could not find the one-ticket quantity control.");

  const continued = await clickFirstVisible(
    [
      page.getByRole("button", { name: /checkout/i }),
      page.getByRole("button", { name: /continue/i }),
      page.getByRole("button", { name: /reserve/i })
    ],
    audit,
    "continued-to-checkout",
    4_000
  );
  if (!continued) throw new Error("Could not find the checkout/continue control.");

  const loginPrompt = page.getByText(/log in|verification code|one-time password/i).first();
  if (await loginPrompt.isVisible().catch(() => false)) {
    throw new Error(
      "POSH login is required. Authenticate normally in Chrome; automated login is not supported."
    );
  }

  // POSH's final control must be tuned against the organizer-owned event during inspection.
  // Keeping this selector exact prevents a broad fallback from submitting the wrong form.
  const finalButton = page.getByRole("button", {
    name: /^(complete rsvp|confirm rsvp|reserve)$/i
  });
  await finalButton.waitFor({ state: "visible", timeout: 10_000 });
  await finalButton.click();

  await page.getByText(/confirmed|you(?:'|’)re going|reservation complete/i).first().waitFor({
    state: "visible",
    timeout: 15_000
  });
  await audit.record("reservation-confirmed");
  return "reserved";
}
