import path from "node:path";
import { expect, test } from "@playwright/test";

test("extension clears an out-of-stock RSVP before selecting the alternative", async ({ page }) => {
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
    <title>Test Event</title>
    <main id="posh-test-root"></main>
    <aside id="posh-toast-root"></aside>
  `);

  await page.evaluate(() => {
    const root = document.querySelector("#posh-test-root") as HTMLElement;
    const toastRoot = document.querySelector("#posh-toast-root") as HTMLElement;
    const state: {
      firstAttempts: number;
      firstRemovals: number;
      secondAttempts: number;
      selectedTicket: string | null;
      staleCheckoutTicket: string | null;
    } = {
      firstAttempts: 0,
      firstRemovals: 0,
      secondAttempts: 0,
      selectedTicket: null,
      staleCheckoutTicket: null
    };
    Object.assign(window, { __autobotTestState: state });

    const renderEvent = () => {
      root.innerHTML = `
        <h1>Test Event</h1>
        <button id="open-rsvp">RSVP</button>
      `;
      root.querySelector("#open-rsvp")?.addEventListener("click", renderPicker);
    };

    const renderOrder = (ticketName: string) => {
      const isFirst = ticketName === "Renamed First Slot";
      root.innerHTML = `
        <h1>Test Event</h1>
        <section role="dialog">
          <h2>Your Order</h2>
          <p>1x ${ticketName}</p>
          <p>Total Due</p>
          <p>Free</p>
          <button id="final-rsvp">RSVP</button>
          <span id="back">Back</span>
        </section>
      `;
      root.querySelector("#back")?.addEventListener("click", renderPicker);
      root.querySelector("#final-rsvp")?.addEventListener("click", () => {
        if (isFirst) {
          const toast = document.createElement("p");
          toast.textContent = "Unfortunately, Renamed First Slot is out of stock. [ms25d6l2]";
          // POSH renders notifications in a portal outside the checkout view.
          // Keep the first failure visible while the alternative is attempted.
          toastRoot.append(toast);
          return;
        }
        state.secondAttempts += 1;
        root.innerHTML = `
          <h1>Test Event</h1>
          <p>Reservation confirmed</p>
        `;
      });
    };

    const renderPicker = () => {
      const firstSelected = state.selectedTicket === "Renamed First Slot";
      const secondSelected = state.selectedTicket === "Different Second Slot";
      const checkoutTicket = state.staleCheckoutTicket || state.selectedTicket;
      root.innerHTML = `
        <h1>Test Event</h1>
        <section role="dialog">
          <article data-sentry-component="EventPageTicketItem">
            <h6>Renamed First Slot</h6>
            <p>Free</p>
            ${
              firstSelected
                ? '<button id="remove-first">−</button><span>1</span><button id="add-first" disabled>+</button>'
                : '<button id="add-first">+</button>'
            }
          </article>
          <article data-sentry-component="EventPageTicketItem">
            <h6>Different Second Slot</h6>
            <p>Free</p>
            ${
              secondSelected
                ? '<button id="remove-second">−</button><span>1</span><button id="add-second" disabled>+</button>'
                : '<button id="add-second">+</button>'
            }
          </article>
          <div id="checkout-slot">
            ${checkoutTicket ? '<button id="checkout">Checkout</button>' : ""}
          </div>
        </section>
      `;

      const prepareCheckout = (ticketName: string) => {
        if (ticketName === "Renamed First Slot") state.firstAttempts += 1;
        state.selectedTicket = ticketName;
        renderPicker();
      };

      root.querySelector("#checkout")?.addEventListener("click", () => {
        if (checkoutTicket) renderOrder(checkoutTicket);
      });
      root
        .querySelector("#add-first")
        ?.addEventListener("click", () => prepareCheckout("Renamed First Slot"));
      root
        .querySelector("#add-second")
        ?.addEventListener("click", () => prepareCheckout("Different Second Slot"));
      root.querySelector("#remove-first")?.addEventListener("click", () => {
        state.firstRemovals += 1;
        // POSH can update the card before it retires the old Checkout
        // control and its first-ticket click handler.
        state.staleCheckoutTicket = "Renamed First Slot";
        state.selectedTicket = null;
        renderPicker();
        setTimeout(() => {
          state.staleCheckoutTicket = null;
          renderPicker();
        }, 100);
      });
    };

    renderEvent();
  });

  await page.addScriptTag({
    path: path.resolve("extension/content.js")
  });

  await page.locator("#execute").check();
  await page.locator("#arm").click();

  await expect(page.getByText("Reservation confirmed", { exact: true })).toBeVisible({
    timeout: 20_000
  });
  await expect(
    page.getByText("Unfortunately, Renamed First Slot is out of stock. [ms25d6l2]", {
      exact: true
    })
  ).toBeVisible();
  const attempts = await page.evaluate(
    () =>
      (window as unknown as {
        __autobotTestState: {
          firstAttempts: number;
          firstRemovals: number;
          secondAttempts: number;
          selectedTicket: string | null;
          staleCheckoutTicket: string | null;
        };
      }).__autobotTestState
  );
  expect(attempts).toEqual({
    firstAttempts: 1,
    firstRemovals: 1,
    secondAttempts: 1,
    selectedTicket: "Different Second Slot",
    staleCheckoutTicket: null
  });
  await expect(page.locator("#status")).toContainText(
    "POSH reported that the ticket is unavailable"
  );
  await expect(page.locator("#status")).toContainText(
    "Removed Renamed First Slot from the order"
  );
  await expect(page.locator("#status")).toContainText(
    "The empty ticket order is settled"
  );
  await expect(page.locator("#status")).toContainText(
    "Resolved ticket: Different Second Slot"
  );
  await expect(page.locator("#status")).toContainText(
    "Verified final order summary: Different Second Slot"
  );
});
