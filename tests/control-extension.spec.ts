import path from "node:path";
import { expect, test } from "@playwright/test";

async function installChromeMock(
  page: import("@playwright/test").Page,
  command: Record<string, unknown>,
  options: { stallReports?: boolean } = {},
) {
  await page.addInitScript(({ initialCommand, stallReports }) => {
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
          if (stallReports) return new Promise(() => {});
          if (
            ["accepted", "standby", "stopped", "reset-complete", "failed", "inspection-complete", "submitted", "confirmed"].includes(
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
  }, { initialCommand: command, stallReports: options.stallReports === true });
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

test("central slot-two assignment selects the second displayed free RSVP", async ({ page }) => {
  await installChromeMock(page, {
    id: "slot-two-command",
    runId: "slot-split-run",
    type: "arm-live",
    payload: {
      runId: "slot-split-run",
      eventUrl: "http://127.0.0.1:4173/event",
      eventTitle: "Two Slot Test",
      releaseAt: Date.now(),
      ticketStrategy: "second",
      leaseId: "slot-two-lease",
      fleetSize: 2,
      execute: true
    }
  });

  await page.goto("http://127.0.0.1:4173/event");
  await page.setContent(`
    <title>Two Slot Test</title>
    <main id="root"><h1>Two Slot Test</h1><button id="open">RSVP</button></main>
  `);
  await page.evaluate(() => {
    const root = document.querySelector("#root") as HTMLElement;
    Object.assign(window, { __selectedSlot: "" });

    const renderPicker = (selected = "") => {
      root.innerHTML = `
        <h1>Two Slot Test</h1>
        <section role="dialog">
          ${["Morning Slot", "Evening Slot"].map((name, index) => `
            <article data-sentry-component="EventPageTicketItem">
              <h6>${name}</h6><p>Free</p>
              ${selected === name
                ? `<button id="remove-${index}">-</button><span>1</span><button disabled>+</button>`
                : `<button id="add-${index}">+</button>`}
            </article>
          `).join("")}
          ${selected ? '<button id="checkout">Checkout</button>' : ""}
        </section>
      `;
      root.querySelector("#add-0")?.addEventListener("click", () => renderPicker("Morning Slot"));
      root.querySelector("#add-1")?.addEventListener("click", () => renderPicker("Evening Slot"));
      root.querySelector("#checkout")?.addEventListener("click", () => {
        (window as unknown as { __selectedSlot: string }).__selectedSlot = selected;
        root.innerHTML = `
          <h1>Two Slot Test</h1>
          <section role="dialog"><h2>Your Order</h2><p>1x ${selected}</p><p>Total Due</p><p>Free</p><button id="finish">RSVP</button></section>
        `;
        root.querySelector("#finish")?.addEventListener("click", () => {
          root.innerHTML = '<h1>Two Slot Test</h1><p>Reservation confirmed</p>';
        });
      });
    };

    root.querySelector("#open")?.addEventListener("click", () => renderPicker());
  });

  await page.addScriptTag({ path: path.resolve("extension/content.js") });
  await expect
    .poll(
      () => page.evaluate(() => (window as unknown as { __selectedSlot: string }).__selectedSlot),
      { timeout: 10_000 },
    )
    .toBe("Evening Slot");
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __autobotControlReports: Array<{ phase: string }> })
              .__autobotControlReports.map((report) => report.phase),
        ),
      { timeout: 10_000 },
    )
    .toContain("confirmed");
});

test("central reset clears this event and makes the device ready to activate again", async ({ page }) => {
  await installChromeMock(page, {
    id: "reset-command",
    runId: null,
    type: "reset",
    payload: {}
  });
  await page.goto("http://127.0.0.1:4173/event");
  await page.setContent("<title>Reset Test</title><main><h1>Reset Test</h1></main>");
  await page.evaluate(async () => {
    const localStorage = (window as unknown as {
      chrome: { storage: { local: { set(values: Record<string, unknown>): Promise<void> } } };
    }).chrome.storage.local;
    await localStorage.set({
      "autobot:/event": {
        armed: true,
        eventTitle: "Reset Test",
        ticketStrategy: "first",
        releaseAt: Date.now() + 60_000,
        execute: true
      },
      "autobot-complete:/event:first slot": { at: new Date().toISOString() }
    });
  });
  await page.addScriptTag({ path: path.resolve("extension/content.js") });

  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __autobotControlReports: Array<{ phase: string }> })
              .__autobotControlReports.map((report) => report.phase),
        ),
      { timeout: 5_000 },
    )
    .toContain("reset-complete");
  const savedKeys = await page.evaluate(async () => {
    const localStorage = (window as unknown as {
      chrome: { storage: { local: { get(keys: null): Promise<Record<string, unknown>> } } };
    }).chrome.storage.local;
    return Object.keys(await localStorage.get(null));
  });
  expect(savedKeys).not.toContain("autobot:/event");
  expect(savedKeys).not.toContain("autobot-complete:/event:first slot");
  await expect(page.locator("#arm")).toHaveText("Run / Arm");
  await expect(page.locator("#status")).toContainText("Reset this event");
});

test("release click does not wait for controller reporting", async ({ page }) => {
  const releaseAt = Date.now() + 1_200;
  await installChromeMock(
    page,
    {
      id: "fast-release-command",
      runId: "fast-release-run",
      type: "arm-live",
      payload: {
        runId: "fast-release-run",
        eventUrl: "http://127.0.0.1:4173/event",
        eventTitle: "Fast Release Test",
        releaseAt,
        ticketStrategy: "first",
        leaseId: "fast-release-lease",
        execute: true
      }
    },
    { stallReports: true },
  );
  await page.goto("http://127.0.0.1:4173/event");
  await page.setContent(
    '<title>Fast Release Test</title><main id="root"><h1>Fast Release Test</h1><button id="open">RSVP</button></main>',
  );
  await page.evaluate(() => {
    Object.assign(window, { __firstReleaseClickAt: 0 });
    document.querySelector("#open")?.addEventListener("click", () => {
      (window as unknown as { __firstReleaseClickAt: number }).__firstReleaseClickAt = Date.now();
    });
  });
  await page.addScriptTag({ path: path.resolve("extension/content.js") });

  await expect
    .poll(
      () => page.evaluate(() => (window as unknown as { __firstReleaseClickAt: number }).__firstReleaseClickAt),
      { timeout: 3_000 },
    )
    .not.toBe(0);
  const observedClickAt = await page.evaluate(
    () => (window as unknown as { __firstReleaseClickAt: number }).__firstReleaseClickAt,
  );
  expect(observedClickAt).toBeGreaterThanOrEqual(releaseAt - 25);
  expect(observedClickAt).toBeLessThan(releaseAt + 500);
});
