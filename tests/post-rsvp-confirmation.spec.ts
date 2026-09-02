import path from "node:path";
import { expect, test } from "@playwright/test";

test("recognizes the POSH post-RSVP update preference dialog as confirmation", async ({ page }) => {
  await page.addInitScript(() => {
    const values: Record<string, unknown> = {};
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
    Object.defineProperty(window, "chrome", {
      value: { storage: { local: storage } },
      configurable: true
    });
  });

  await page.goto("http://127.0.0.1:4173/event");
  await page.setContent(`
    <title>Popup Confirmation Test</title>
    <main id="posh-test-root">
      <h1>Popup Confirmation Test</h1>
      <button id="open-rsvp">RSVP</button>
    </main>
  `);
  await page.evaluate(() => {
    const root = document.querySelector("#posh-test-root") as HTMLElement;
    Object.assign(window, { __finalRsvpClicks: 0 });

    const renderPicker = (selected = false) => {
      root.innerHTML = `
        <h1>Popup Confirmation Test</h1>
        <section role="dialog">
          <article data-sentry-component="EventPageTicketItem">
            <h6>Free Test RSVP</h6>
            <p>Free</p>
            ${
              selected
                ? '<button id="remove-ticket">-</button><span>1</span><button id="add-ticket" disabled>+</button>'
                : '<button id="add-ticket">+</button>'
            }
          </article>
          ${selected ? '<button id="checkout">Checkout</button>' : ""}
        </section>
      `;
      root.querySelector("#add-ticket")?.addEventListener("click", () => renderPicker(true));
      root.querySelector("#checkout")?.addEventListener("click", renderOrder);
    };

    const renderOrder = () => {
      root.innerHTML = `
        <h1>Popup Confirmation Test</h1>
        <section role="dialog">
          <h2>Your Order</h2>
          <p>1x Free Test RSVP</p>
          <p>Total Due</p>
          <p>Free</p>
          <button id="final-rsvp">RSVP</button>
          <span>Back</span>
        </section>
      `;
      root.querySelector("#final-rsvp")?.addEventListener("click", () => {
        (window as unknown as { __finalRsvpClicks: number }).__finalRsvpClicks += 1;
        root.innerHTML = `
          <h1>Popup Confirmation Test</h1>
          <section role="dialog" aria-modal="true">
            <h2>Stay in the loop</h2>
            <p>Get event updates and promotional texts from AUTOBOT. You can unsubscribe anytime.</p>
            <button>No, email me instead</button>
            <button>Yes, text me updates →</button>
          </section>
        `;
      });
    };

    root.querySelector("#open-rsvp")?.addEventListener("click", () => renderPicker());
  });

  await page.addScriptTag({ path: path.resolve("extension/content.js") });
  await page.locator("#execute").check();
  await page.locator("#arm").click();

  await expect(page.getByText("Stay in the loop", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#status")).toContainText("Reservation confirmed.", { timeout: 15_000 });
  expect(await page.evaluate(() => (window as unknown as { __finalRsvpClicks: number }).__finalRsvpClicks)).toBe(1);
});
