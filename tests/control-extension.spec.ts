import path from "node:path";
import { expect, test } from "@playwright/test";

async function installChromeMock(page: import("@playwright/test").Page, command: Record<string, unknown>) {
  await page.addInitScript((initialCommand) => {
    const values: Record<string, unknown> = {};
    let pending: Record<string, unknown> | null = initialCommand;
    const reports: Array<Record<string, unknown>> = [];
    Object.assign(window, { __autobotControlReports: reports });
    const storage = {
      async get(keys: string | string[] | null) {
        if (keys === null) return { ...values };
        const wanted = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(wanted.map((key) => [key, values[key]]));
      },
      async set(next: Record<string, unknown>) {
        Object.assign(values, next);
      },
      async remove(keys: string | string[]) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
      }
    };
    const runtime = {
      async sendMessage(message: Record<string, unknown>) {
        if (message.type === "autobot:control-poll") {
          return { connected: true, deviceName: "Test Device", command: pending };
        }
        if (message.type === "autobot:control-report") {
          const report = message.report as Record<string, unknown>;
          reports.push(report);
          if (
            ["accepted", "standby", "stopped", "failed", "inspection-complete", "submitted", "confirmed"].includes(
              String(report.phase)
            )
          ) {
            pending = null;
          }
          return { ok: true };
        }
        return null;
      }
    };
    Object.defineProperty(window, "chrome", {
      value: { storage: { local: storage }, runtime },
      configurable: true
    });
  }, command);
}

test("central inspection command verifies a free ticket without selecting it", async ({ page }) => {
  const releaseAt = Date.now();
  await installChromeMock(page, {
    id: "inspect-command",
    runId: "inspection-run",
    type: "inspect",
    payload: {
      runId: "inspection-run",
      eventUrl: "http://127.0.0.1:4173/event",
      eventTitle: "AUTOBOT Classroom Test Drop",
      releaseAt,
      ticketStrategy: "any",
      execute: false
    }
  });

  await page.goto("http://127.0.0.1:4173/event");
  await page.setContent(`
    <title>AUTOBOT Classroom Test Drop</title>
    <main id="root">
      <h1>AUTOBOT Classroom Test Drop</h1>
      <button id="open">RSVP</button>
    </main>
  `);
  await page.evaluate(() => {
    Object.assign(window, { __ticketAdds: 0 });
    const root = document.querySelector("#root") as HTMLElement;
    root.querySelector("#open")?.addEventListener("click", () => {
      root.innerHTML = `
        <h1>AUTOBOT Classroom Test Drop</h1>
        <section role="dialog">
          <article data-sentry-component="EventPageTicketItem">
            <h6>Free Test RSVP</h6><p>Free</p><button id="add">+</button>
          </article>
        </section>
      `;
      root.querySelector("#add")?.addEventListener("click", () => {
        (window as unknown as { __ticketAdds: number }).__ticketAdds += 1;
      });
    });
  });

  await page.addScriptTag({ path: path.resolve("extension/content.js") });
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __autobotControlReports: Array<{ phase: string }> })
              .__autobotControlReports.map((report) => report.phase)
        ),
      { timeout: 10_000 }
    )
    .toContain("inspection-complete");
  expect(await page.evaluate(() => (window as unknown as { __ticketAdds: number }).__ticketAdds)).toBe(0);
  await expect(page.locator("#autobot-owned-event-lab")).toBeAttached();
});

test("standby receives the fleet password and time without clicking the event", async ({ page }) => {
  const releaseAt = Date.now() + 60_000;
  await installChromeMock(page, {
    id: "standby-command",
    runId: "live-run",
    type: "standby",
    payload: {
      runId: "live-run",
      eventUrl: "http://127.0.0.1:4173/event",
      eventTitle: "AUTOBOT Classroom Test Drop",
      primaryDeviceId: "other-device",
      releaseAt,
      ticketStrategy: "any",
      eventPassword: "fleet-password"
    }
  });
  await page.goto("http://127.0.0.1:4173/event");
  await page.setContent(`
    <title>AUTOBOT Classroom Test Drop</title>
    <main>
      <form><input id="posh-password" placeholder="Password"><button id="password-submit" type="submit">Enter</button></form>
      <h1>AUTOBOT Classroom Test Drop</h1>
      <button id="event-action">RSVP</button>
    </main>
  `);
  await page.evaluate(() => {
    Object.assign(window, { __standbyClicks: 0 });
    document.querySelector("#event-action")?.addEventListener("click", () => {
      (window as unknown as { __standbyClicks: number }).__standbyClicks += 1;
    });
    document.querySelector("form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      (window as unknown as { __standbyClicks: number }).__standbyClicks += 1;
    });
  });
  await page.addScriptTag({ path: path.resolve("extension/content.js") });

  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __autobotControlReports: Array<{ phase: string }> })
              .__autobotControlReports.map((report) => report.phase)
        ),
      { timeout: 5_000 }
    )
    .toContain("standby");
  expect(
    await page.evaluate(() => (window as unknown as { __standbyClicks: number }).__standbyClicks)
  ).toBe(0);
  await expect(page.locator("#posh-password")).toHaveValue("fleet-password");
  await expect(page.locator("#event-password")).toHaveValue("fleet-password");
  await expect(page.locator("#release-at")).not.toHaveValue("");
  await expect(page.locator("#arm")).toContainText("Standby");
});

test("live fleet command arms one independent executor without clicking before release", async ({ page }) => {
  const releaseAt = Date.now() + 60_000;
  await installChromeMock(page, {
    id: "fleet-executor-command",
    runId: "fleet-live-run",
    type: "arm-live",
    payload: {
      runId: "fleet-live-run",
      eventUrl: "http://127.0.0.1:4173/event",
      eventTitle: "AUTOBOT Classroom Test Drop",
      releaseAt,
      ticketStrategy: "any",
      eventPassword: "fleet-password",
      leaseId: "executor-lease-1",
      fleetSize: 2,
      execute: true
    }
  });
  await page.goto("http://127.0.0.1:4173/event");
  await page.setContent(`
    <title>AUTOBOT Classroom Test Drop</title>
    <main>
      <h1>AUTOBOT Classroom Test Drop</h1>
      <button id="event-action">RSVP</button>
    </main>
  `);
  await page.evaluate(() => {
    Object.assign(window, { __fleetClicks: 0 });
    document.querySelector("#event-action")?.addEventListener("click", () => {
      (window as unknown as { __fleetClicks: number }).__fleetClicks += 1;
    });
  });
  await page.addScriptTag({ path: path.resolve("extension/content.js") });

  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __autobotControlReports: Array<{ phase: string }> })
              .__autobotControlReports.map((report) => report.phase)
        ),
      { timeout: 5_000 }
    )
    .toContain("accepted");
  expect(await page.evaluate(() => (window as unknown as { __fleetClicks: number }).__fleetClicks)).toBe(0);
  await expect(page.locator("#execute")).toBeChecked();
  await expect(page.locator("#event-password")).toHaveValue("fleet-password");
  await expect(page.locator("#release-at")).not.toHaveValue("");
  await expect(page.locator("#arm")).toContainText("Armed");
});
