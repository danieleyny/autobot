(() => {
  "use strict";

  const ROOT_ID = "autobot-owned-event-lab";
  const STATE_KEY = `autobot:${location.pathname}`;
  const SUCCESS_PATTERN = /reservation confirmed|rsvp confirmed|you(?:'|’)re going|order confirmed/i;
  const DUPLICATE_PATTERN =
    /already (?:have|registered|rsvp|reserved)|already going|limit reached|ticket limit|maximum number of tickets/i;
  const SOLD_OUT_PATTERN =
    /sold out|out of stock|no longer available|not enough tickets|ticket(?:s)? unavailable|quantity unavailable|inventory changed|capacity reached|could not complete (?:the )?reservation|unable to (?:complete|reserve)|failed to reserve/i;
  const LOGIN_PATTERN = /what(?:'|’)s your phone number|login or sign up|verification code|one-time password/i;
  const PAYMENT_PATTERN = /card number|credit card|affirm|payment method|billing address/i;
  const ANTI_BOT_PATTERN =
    /captcha|turnstile|cloudflare|verifying you(?:'|’)re not a robot|too many requests|rate limit|temporarily blocked/i;
  const DOM_POLL_MS = 25;
  const STALLED_ORDER_GRACE_MS = 3_000;
  const GATE_EARLY_MS = 120_000;
  const GATE_LATE_MS = 120_000;
  const GATE_ATTEMPT_OFFSETS_MS = [
    ...Array.from({ length: 30 }, (_, index) => (-120 + index * 3) * 1000),
    ...Array.from({ length: 61 }, (_, index) => (-30 + index) * 1000),
    ...Array.from({ length: 30 }, (_, index) => (33 + index * 3) * 1000)
  ];
  const MAX_TICKET_ATTEMPTS = 2;

  if (document.getElementById(ROOT_ID)) return;

  const host = document.createElement("div");
  host.id = ROOT_ID;
  document.documentElement.append(host);
  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .panel {
        position: fixed; z-index: 2147483647; right: 18px; bottom: 18px;
        width: min(360px, calc(100vw - 36px)); box-sizing: border-box;
        border: 1px solid #3b3f47; border-radius: 16px; padding: 16px;
        color: #f6f7f8; background: rgba(14, 15, 18, .97);
        box-shadow: 0 20px 60px rgba(0,0,0,.45);
        font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      }
      h2 { margin: 0 0 4px; font-size: 16px; }
      .sub { margin: 0 0 14px; color: #aeb4bf; font-size: 12px; }
      label { display: block; margin: 10px 0 4px; color: #d9dce2; font-weight: 650; }
      input, select {
        width: 100%; box-sizing: border-box; border: 1px solid #414650;
        border-radius: 9px; padding: 9px 10px; color: #fff; background: #202229;
        font: inherit;
      }
      .check { display: flex; align-items: center; gap: 8px; font-weight: 500; }
      .check input { width: auto; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
      button {
        flex: 1; border: 0; border-radius: 999px; padding: 10px 12px;
        color: #10120d; background: #b8ff5a; font: inherit; font-weight: 800;
        cursor: pointer;
      }
      button.secondary { color: #eef0f3; background: #343842; }
      #reset-lock { flex-basis: 100%; }
      button:disabled { opacity: .5; cursor: not-allowed; }
      .status {
        min-height: 38px; max-height: 110px; overflow: auto; margin-top: 12px;
        border-radius: 9px; padding: 9px 10px; color: #b8ff5a; background: #090a0c;
        white-space: pre-wrap; font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .warning { margin-top: 10px; color: #f4c66b; font-size: 11px; }
    </style>
    <section class="panel" aria-label="AUTOBOT classroom control">
      <h2>AUTOBOT RSVP Lab <small>v0.6.5</small></h2>
      <p class="sub">Organizer-owned event · one ticket · visible browser</p>

      <label for="event-title">Exact event title</label>
      <input id="event-title" placeholder="GRAND BAZAAR: PIERRE LABORDE" autocomplete="off">

      <label for="ticket-selection">Ticket selection</label>
      <select id="ticket-selection">
        <option value="any">Any available free RSVP (recommended)</option>
        <option value="first">First available free RSVP</option>
        <option value="second">Second available free RSVP</option>
      </select>

      <label for="event-password">Event password (memory only)</label>
      <input id="event-password" type="password" placeholder="Only needed while the gate is visible" autocomplete="off">

      <label for="release-at">Release time (optional, local time)</label>
      <input id="release-at" type="datetime-local">

      <label class="check">
        <input id="release-gate" type="checkbox" checked>
        Four-minute password retry window (no refresh)
      </label>

      <label class="check">
        <input id="execute" type="checkbox">
        Execute one free RSVP (unchecked = inspection only)
      </label>

      <div class="actions">
        <button id="arm">Run / Arm</button>
        <button id="disarm" class="secondary">Stop</button>
        <button id="reset-lock" class="secondary">Reset this event's test locks</button>
      </div>
      <div id="status" class="status" role="status">Ready. Authenticate with POSH normally before executing.</div>
      <div class="warning">Stops for login, CAPTCHA, payment, ambiguity, or unexpected checkout fields.</div>
    </section>
  `;

  const $ = (selector) => shadow.querySelector(selector);
  const status = $("#status");
  const armButton = $("#arm");
  const disarmButton = $("#disarm");
  const resetLockButton = $("#reset-lock");
  let stopped = false;
  let countdownTimer = null;

  function log(message) {
    const time = new Date().toLocaleTimeString();
    status.textContent = `[${time}] ${message}\n${status.textContent}`.slice(0, 3000);
  }

  function normalize(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function sameText(left, right) {
    return normalize(left).toLocaleLowerCase() === normalize(right).toLocaleLowerCase();
  }

  function completionKey(ticketName) {
    return `autobot-complete:${location.pathname}:${ticketName.toLowerCase()}`;
  }

  function visible(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  }

  function exactText(selector, text) {
    return [...document.querySelectorAll(selector)].filter(
      (element) => visible(element) && sameText(element.textContent, text)
    );
  }

  function exactButton(...labels) {
    const wanted = labels.map(normalize);
    const matches = [
      ...document.querySelectorAll(
        'button, a[href], [role="button"], input[type="button"], input[type="submit"]'
      )
    ].filter(
      (element) =>
        visible(element) &&
        !element.disabled &&
        element.getAttribute("aria-disabled") !== "true" &&
        wanted.some((label) =>
          sameText(
            element instanceof HTMLInputElement ? element.value : element.textContent,
            label
          )
        )
    );

    // POSH can nest a native button inside a role=button wrapper. Prefer the
    // innermost matching control so one visual action is never counted twice.
    return matches.filter(
      (element) =>
        !matches.some((other) => other !== element && element.contains(other))
    );
  }

  function exactVisibleAction(label) {
    const semanticMatches = exactButton(label);
    if (semanticMatches.length === 1) return semanticMatches[0];
    if (semanticMatches.length > 1) return null;

    const textMatches = [...document.querySelectorAll("body *")].filter(
      (element) => visible(element) && sameText(element.textContent, label)
    );
    const innermostMatches = textMatches.filter(
      (element) =>
        !textMatches.some((other) => other !== element && element.contains(other))
    );
    return innermostMatches.length === 1 ? innermostMatches[0] : null;
  }

  async function waitFor(read, timeoutMs, description) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (stopped) throw new Error("Stopped by user.");
      const result = read();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, DOM_POLL_MS));
    }
    throw new Error(`Timed out waiting for ${description}.`);
  }

  function setNativeValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function passwordGate() {
    const input = [...document.querySelectorAll('input[placeholder="Password"]')].find(visible);
    if (!input) return null;
    const formSubmit = input.closest("form")?.querySelector('button[type="submit"]');
    const submit = formSubmit || document.querySelector('button[type="submit"]');
    return { input, submit };
  }

  function assertNoBlockingChallenge() {
    const bodyText = normalize(document.body.innerText);
    if (ANTI_BOT_PATTERN.test(bodyText)) {
      throw new Error("Safety stop: POSH or Cloudflare displayed an anti-bot or rate-limit check.");
    }
    if (LOGIN_PATTERN.test(bodyText)) {
      throw new Error("POSH login is required. Authenticate normally, then re-arm.");
    }
  }

  async function unlockEvent(config) {
    const gate = passwordGate();
    if (!gate) return;
    if (!config.eventPassword) throw new Error("The event password gate is visible, but no password was provided.");

    if (!gate.submit || !visible(gate.submit)) {
      throw new Error("The event password submit control is not uniquely available.");
    }

    setNativeValue(gate.input, config.eventPassword);
    gate.submit.click();
    await waitFor(
      () => exactText("h1", config.eventTitle).length === 1,
      10_000,
      `event heading "${config.eventTitle}"`
    );
    $("#event-password").value = "";
    log("Event password accepted; password cleared from the helper.");
  }

  async function tryEventPassword(config) {
    if (exactText("h1", config.eventTitle).length === 1) return true;
    assertNoBlockingChallenge();

    const gate = passwordGate();
    if (!gate) return false;
    if (!gate.submit || !visible(gate.submit) || gate.submit.disabled) return false;

    setNativeValue(gate.input, "");
    setNativeValue(gate.input, config.eventPassword);
    gate.submit.click();

    const started = Date.now();
    while (Date.now() - started < 5_000) {
      if (stopped) throw new Error("Stopped by user.");
      if (exactText("h1", config.eventTitle).length === 1) return true;
      assertNoBlockingChallenge();
      const currentGate = passwordGate();
      if (
        Date.now() - started >= 150 &&
        currentGate?.submit &&
        !currentGate.submit.disabled &&
        currentGate.input.value === ""
      ) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, DOM_POLL_MS));
    }
    return false;
  }

  function assertEvent(config) {
    const matches = exactText("h1", config.eventTitle);
    if (matches.length !== 1) {
      throw new Error(`Expected one visible event heading "${config.eventTitle}", found ${matches.length}.`);
    }
  }

  function visibleTicketDialog() {
    return (
      [...document.querySelectorAll('[role="dialog"]')].find(
        (dialog) =>
          visible(dialog) &&
          [...dialog.querySelectorAll('[data-sentry-component="EventPageTicketItem"]')].some(
            visible
          )
      ) || null
    );
  }

  async function openTicketPicker() {
    if (visibleTicketDialog()) {
      log("Ticket selector is already open.");
      return;
    }

    const buttons = await waitFor(() => {
      const matches = exactButton("RSVP", "Get Tickets");
      return matches.length === 1 ? matches : null;
    }, 10_000, "one RSVP/Get Tickets control");
    if (buttons.length !== 1) {
      throw new Error(`Expected one RSVP/Get Tickets control, found ${buttons.length}.`);
    }
    buttons[0].click();
    await waitFor(
      () => visibleTicketDialog(),
      8_000,
      "the ticket dialog"
    );
    log("Ticket selector opened.");
  }

  function findTicketCard(ticketName) {
    const cards = [...document.querySelectorAll('[data-sentry-component="EventPageTicketItem"]')];
    return cards.filter((card) => {
      const heading = card.querySelector("h6");
      return visible(card) && sameText(heading?.textContent, ticketName);
    });
  }

  function cardTicketName(card) {
    return normalize(card.querySelector("h6")?.innerText);
  }

  function availableFreeTicketCards(excludedTicketNames = []) {
    const excluded = new Set(
      excludedTicketNames.map((ticketName) => normalize(ticketName).toLocaleLowerCase())
    );
    return [...document.querySelectorAll('[data-sentry-component="EventPageTicketItem"]')].filter(
      (card) => {
        if (!visible(card)) return false;
        const ticketName = cardTicketName(card);
        if (!ticketName || excluded.has(ticketName.toLocaleLowerCase())) return false;
        const renderedText = normalize(card.innerText);
        const enabledButtons = [...card.querySelectorAll("button")].filter(
          (button) => visible(button) && !button.disabled
        );
        return (
          /\bFree\b|\bRSVP\b|\$0(?:\.00)?\b/i.test(renderedText) &&
          enabledButtons.length === 1
        );
      }
    );
  }

  function visibleSoldOutEvidence() {
    const matches = [...document.querySelectorAll("body *")].filter(
      (element) =>
        visible(element) &&
        SOLD_OUT_PATTERN.test(normalize(element.innerText || element.textContent))
    );
    const innermostMatches = matches.filter(
      (element) =>
        !matches.some((other) => other !== element && element.contains(other))
    );
    return new Set(
      innermostMatches.map((element) =>
        normalize(element.innerText || element.textContent).toLocaleLowerCase()
      )
    );
  }

  function hasNewSoldOutEvidence(existingEvidence) {
    return [...visibleSoldOutEvidence()].some(
      (message) => !existingEvidence.has(message)
    );
  }

  async function returnForNextTicket(config) {
    if (visibleTicketDialog()) return;

    const bodyText = normalize(document.body.innerText);
    const onOrderPage = /\bYour Order\b/i.test(bodyText) || /\bTotal Due\b/i.test(bodyText);
    if (!onOrderPage && exactButton("RSVP", "Get Tickets").length === 1) return;

    const backControl =
      exactVisibleAction("Back") ||
      exactVisibleAction("Change Tickets") ||
      exactVisibleAction("Edit Order") ||
      exactVisibleAction("Try Again");
    if (backControl) {
      backControl.click();
    } else if (history.length > 1) {
      history.back();
    } else {
      throw new Error("A ticket sold out, but no safe return control was available.");
    }

    await waitFor(
      () =>
        visibleTicketDialog() ||
        exactButton("RSVP", "Get Tickets").length === 1,
      8_000,
      "the ticket selector or event RSVP control"
    );
    assertEvent(config);
  }

  function stalledOrderPageVisible() {
    const bodyText = normalize(document.body.innerText);
    return (
      /\bYour Order\b/i.test(bodyText) &&
      /\bTotal Due\b/i.test(bodyText) &&
      Boolean(exactVisibleAction("Back"))
    );
  }

  async function clearFailedTicketSelection(failedTicketName) {
    const card = await waitFor(() => {
      const matches = findTicketCard(failedTicketName);
      if (matches.length === 1) return matches[0];
      if (matches.length === 0) return "removed";
      return null;
    }, 5_000, `the previously selected ticket "${failedTicketName}"`);

    if (card === "removed") {
      log(`${failedTicketName} is no longer in the selector; no quantity removal was needed.`);
      return;
    }

    const visibleButtons = [...card.querySelectorAll("button")].filter(visible);
    const labeledRemoveButtons = visibleButtons.filter((button) =>
      /remove|decrease|decrement|minus/i.test(
        `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`
      )
    );
    const cardText = normalize(card.innerText);
    const showsSelectedQuantity = /(?:^|\s)1(?:\s|$)/.test(cardText);

    let removeButton = null;
    if (labeledRemoveButtons.length === 1) {
      removeButton = labeledRemoveButtons[0];
    } else if (visibleButtons.length === 2) {
      removeButton = visibleButtons[0];
    } else if (visibleButtons.length === 1 && showsSelectedQuantity) {
      removeButton = visibleButtons[0];
    } else if (visibleButtons.length === 1 && !showsSelectedQuantity) {
      log(`${failedTicketName} was already removed from the order.`);
      return;
    }

    if (!removeButton) {
      throw new Error(`Could not uniquely identify the quantity-removal control for ${failedTicketName}.`);
    }

    removeButton.click();
    await waitFor(() => {
      const matches = findTicketCard(failedTicketName);
      if (matches.length === 0) return true;
      if (matches.length !== 1) return false;
      const remainingButtons = [...matches[0].querySelectorAll("button")].filter(visible);
      const remainingText = normalize(matches[0].innerText);
      return (
        remainingButtons.length <= 1 &&
        !/(?:^|\s)1(?:\s|$)/.test(remainingText)
      );
    }, 4_000, `removal of ${failedTicketName} from the order`);
    log(`Removed ${failedTicketName} from the order before trying the alternative.`);
  }

  async function retryNextTicket(config, failedTicketName, reason) {
    const excludedTicketNames = [
      ...new Set([...(config.excludedTicketNames || []), failedTicketName])
    ];
    if (excludedTicketNames.length >= MAX_TICKET_ATTEMPTS) {
      throw new Error("Both free RSVP options were attempted and are unavailable or sold out.");
    }

    log(`${reason}; returning from ${failedTicketName} for the next free RSVP.`);
    await returnForNextTicket(config);
    await openTicketPicker();
    await clearFailedTicketSelection(failedTicketName);
    await executeReservation({
      ...config,
      ticketStrategy: "any",
      ticketName: "",
      excludedTicketNames
    });
  }

  async function executeReservation(config) {
    if (stopped) return;
    assertEvent(config);
    await openTicketPicker();

    let selectionMessage = "";
    const cards = await waitFor(
      () => {
        const available = availableFreeTicketCards(config.excludedTicketNames || []);
        if (config.ticketStrategy === "any" && available.length >= 1) {
          selectionMessage = "Selected the first currently available free RSVP.";
          return [available[0]];
        }
        if (config.ticketStrategy === "first" && available.length >= 1) {
          selectionMessage = "Selected the first available free RSVP by displayed order.";
          return [available[0]];
        }
        if (config.ticketStrategy === "second" && available.length >= 2) {
          selectionMessage = "Selected the second available free RSVP by displayed order.";
          return [available[1]];
        }
        if (config.ticketStrategy === "second" && available.length === 1) {
          selectionMessage = "Only one free RSVP is available; selected that sole option.";
          return [available[0]];
        }

        // Compatibility for an armed state saved by v0.4.x before an extension
        // reload. New runs use ticketStrategy and do not depend on the name.
        if (!config.ticketStrategy && config.ticketName) {
          const matches = findTicketCard(config.ticketName);
          if (matches.length === 1) {
            selectionMessage = `Selected legacy exact-name match: ${config.ticketName}.`;
            return matches;
          }
          if (available.length === 1) {
            selectionMessage = "Legacy name did not match; selected the sole available free RSVP.";
            return [available[0]];
          }
        }
        return null;
      },
      8_000,
      "an available free RSVP for the selected strategy"
    );
    if (cards.length !== 1) throw new Error(`Expected one matching ticket card, found ${cards.length}.`);

    const card = cards[0];
    const resolvedTicketName = normalize(card.querySelector("h6")?.innerText);
    if (!resolvedTicketName) throw new Error("The selected ticket card has no visible name.");
    log(`${selectionMessage} Resolved ticket: ${resolvedTicketName}.`);
    const resolvedCompletionKey = completionKey(resolvedTicketName);
    const resolvedCompletion =
      (await chrome.storage.local.get(resolvedCompletionKey))[resolvedCompletionKey];
    if (resolvedCompletion) {
      throw new Error(
        `One-shot lock: this browser already submitted ${resolvedTicketName} on ${new Date(resolvedCompletion.at).toLocaleString()}.`
      );
    }
    config.ticketName = resolvedTicketName;
    // innerText preserves the visual separation between the ticket name and
    // price. textContent can collapse POSH's adjacent elements into
    // "10 am ticketFree", which defeats word-boundary safety checks.
    const cardText = normalize(card.innerText);
    if (!/\bFree\b|\bRSVP\b|\$0(?:\.00)?\b/i.test(cardText)) {
      throw new Error("Safety stop: the target ticket is not visibly marked Free, RSVP, or $0.");
    }
    log(`Verified free ticket: ${resolvedTicketName}.`);

    if (!config.execute) {
      log("Inspection complete. No ticket was selected.");
      await clearState();
      return;
    }

    const addButtons = [...card.querySelectorAll("button")].filter(visible);
    if (addButtons.length !== 1) {
      throw new Error(`Expected one add control in the ticket card, found ${addButtons.length}.`);
    }

    const state = await loadState();
    const attemptedTicketNames = state?.attemptedTicketNames || [];
    if (attemptedTicketNames.some((ticketName) => sameText(ticketName, resolvedTicketName))) {
      throw new Error(`Safety stop: this run already attempted ${resolvedTicketName}.`);
    }
    if (attemptedTicketNames.length >= MAX_TICKET_ATTEMPTS) {
      throw new Error("Safety stop: this run already attempted both RSVP options.");
    }
    await saveState({
      ...state,
      attemptedTicketNames: [...attemptedTicketNames, resolvedTicketName]
    });

    addButtons[0].click();
    await waitFor(
      () => exactButton("Checkout").length === 1,
      5_000,
      "Checkout"
    );

    const checkout = exactButton("Checkout");
    if (checkout.length !== 1) throw new Error(`Expected one Checkout button, found ${checkout.length}.`);
    const soldOutBeforeCheckout = visibleSoldOutEvidence();
    checkout[0].click();
    log("One ticket selected; checkout requested.");

    const outcome = await waitFor(() => {
      const bodyText = normalize(document.body.innerText);
      if (SUCCESS_PATTERN.test(bodyText)) return "success";
      if (hasNewSoldOutEvidence(soldOutBeforeCheckout)) return "soldout";
      if (LOGIN_PATTERN.test(bodyText)) return "login";
      if (PAYMENT_PATTERN.test(bodyText)) return "payment";
      const final = exactButton("Complete RSVP", "Confirm RSVP", "Reserve");
      if (final.length === 1) return final[0];
      const finalRsvp = exactButton("RSVP");
      const hasOrderSummary =
        /\bYour Order\b/i.test(bodyText) &&
        /\bTotal Due\b/i.test(bodyText) &&
        /\bFree\b/i.test(bodyText);
      if (hasOrderSummary && finalRsvp.length === 1) return finalRsvp[0];
      return null;
    }, 12_000, "checkout result");

    if (outcome === "success") {
      log("Reservation confirmed.");
      await markCompleted(config, "confirmed");
      return;
    }
    if (outcome === "soldout") {
      await retryNextTicket(config, resolvedTicketName, "POSH reported that the ticket is unavailable");
      return;
    }
    if (outcome === "login") throw new Error("POSH login is required. Authenticate normally, then re-arm.");
    if (outcome === "payment") throw new Error("Safety stop: payment UI appeared.");

    const finalText = normalize(document.body.innerText);
    if (PAYMENT_PATTERN.test(finalText)) throw new Error("Safety stop: payment UI appeared.");
    if (
      normalize(outcome.textContent) === "RSVP" &&
      !(
        /\bYour Order\b/i.test(finalText) &&
        /\bTotal Due\b/i.test(finalText) &&
        /\bFree\b/i.test(finalText)
      )
    ) {
      throw new Error("Safety stop: the final RSVP button is not inside a verified free-order state.");
    }
    const soldOutBeforeFinalSubmit = visibleSoldOutEvidence();
    outcome.click();
    log("Final RSVP submitted once. Waiting for POSH confirmation.");
    const finalSubmittedAt = Date.now();

    let finalResult;
    try {
      finalResult = await waitFor(() => {
        const bodyText = normalize(document.body.innerText);
        if (SUCCESS_PATTERN.test(bodyText)) return "success";
        if (hasNewSoldOutEvidence(soldOutBeforeFinalSubmit)) return "soldout";
        if (DUPLICATE_PATTERN.test(bodyText)) return "duplicate";
        if (
          Date.now() - finalSubmittedAt >= STALLED_ORDER_GRACE_MS &&
          stalledOrderPageVisible()
        ) {
          return "stalled";
        }
        return null;
      }, 12_000, "reservation confirmation");
    } catch {
      if (stalledOrderPageVisible()) {
        await retryNextTicket(
          config,
          resolvedTicketName,
          "No confirmation appeared and the order page still has a Back control"
        );
        return;
      }

      await markCompleted(config, "submitted-unconfirmed");
      log("Final RSVP was submitted once, but POSH showed no recognized confirmation. Do not retry; verify the ticket in My Orders.");
      return;
    }

    if (finalResult === "stalled") {
      await retryNextTicket(
        config,
        resolvedTicketName,
        "The order page remained unchanged for three seconds after final RSVP"
      );
      return;
    }
    if (finalResult === "duplicate") {
      await markCompleted(config, "already-reserved");
      log("POSH reports that this account already has or reached the limit for this event.");
      return;
    }
    if (finalResult === "soldout") {
      await retryNextTicket(config, resolvedTicketName, "POSH reported that the ticket is unavailable");
      return;
    }

    await markCompleted(config, "confirmed");
    log("Reservation confirmed.");
  }

  function configFromPanel() {
    const releaseValue = $("#release-at").value;
    const releaseAt = releaseValue ? new Date(releaseValue).getTime() : Date.now();
    if (!Number.isFinite(releaseAt)) throw new Error("Release time is invalid.");
    return {
      eventTitle:
        normalize($("#event-title").value) ||
        normalize(document.title) ||
        "GRAND BAZAAR: PIERRE LABORDE",
      ticketStrategy: $("#ticket-selection").value,
      ticketName: "",
      eventPassword: $("#event-password").value,
      releaseAt,
      releaseConfigured: Boolean(releaseValue),
      retryGate: $("#release-gate").checked,
      execute: $("#execute").checked,
      attemptedTicketNames: [],
      excludedTicketNames: [],
      armed: true
    };
  }

  async function saveState(state) {
    await chrome.storage.local.set({ [STATE_KEY]: state });
  }

  async function loadState() {
    const stored = await chrome.storage.local.get(STATE_KEY);
    return stored[STATE_KEY] || null;
  }

  async function clearState() {
    await chrome.storage.local.remove(STATE_KEY);
  }

  async function markCompleted(config, result) {
    await chrome.storage.local.set({
      [completionKey(config.ticketName)]: {
        at: new Date().toISOString(),
        eventTitle: config.eventTitle,
        ticketName: config.ticketName,
        result
      }
    });
    await clearState();
  }

  async function schedule(config, reloadAtRelease) {
    const remaining = config.releaseAt - Date.now();
    if (remaining <= 0) {
      await executeReservation(config);
      return;
    }

    log(`Armed. Waiting ${Math.ceil(remaining / 1000)} seconds.`);
    countdownTimer = setInterval(() => {
      const seconds = Math.max(0, Math.ceil((config.releaseAt - Date.now()) / 1000));
      armButton.textContent = `Armed · ${seconds}s`;
    }, 250);

    setTimeout(async () => {
      if (stopped) return;
      clearInterval(countdownTimer);
      if (reloadAtRelease) {
        log("Release time reached; refreshing once.");
        location.reload();
      } else {
        await executeReservation(config).catch(fail);
      }
    }, remaining);
  }

  async function waitUntil(timestamp) {
    while (!stopped && Date.now() < timestamp) {
      const remaining = timestamp - Date.now();
      armButton.textContent = `Armed · ${Math.max(0, Math.ceil(remaining / 1000))}s`;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
    }
    if (stopped) throw new Error("Stopped by user.");
  }

  async function runReleaseGate(config) {
    if (!config.eventPassword) {
      throw new Error("A password is required for release-gate retry mode.");
    }

    const startAt = config.releaseAt - GATE_EARLY_MS;
    const stopAt = config.releaseAt + GATE_LATE_MS;
    if (Date.now() < startAt) {
      log(`Armed. Password attempts begin two minutes before release.`);
      await waitUntil(startAt);
    }
    if (Date.now() > stopAt) {
      throw new Error("The password retry window ended more than two minutes ago.");
    }

    let attempts = 0;
    log(`Release-gate window started. Using up to ${GATE_ATTEMPT_OFFSETS_MS.length} fixed clock targets with no refresh.`);
    for (const offset of GATE_ATTEMPT_OFFSETS_MS) {
      const scheduledAt = config.releaseAt + offset;
      if (scheduledAt < Date.now()) continue;
      await waitUntil(scheduledAt);

      attempts += 1;
      const unlocked = await tryEventPassword(config);
      if (unlocked) {
        $("#event-password").value = "";
        log(`Event password accepted on attempt ${attempts}; password cleared from the helper.`);
        const safeState = {
          ...config,
          eventPassword: "",
          gateRetrying: false
        };
        await saveState(safeState);
        log("Gate opened; starting the RSVP sequence immediately.");
        await executeReservation(safeState);
        return;
      }

      const signedSeconds = Math.round(offset / 1000);
      const targetLabel =
        signedSeconds === 0
          ? "release"
          : `${Math.abs(signedSeconds)}s ${signedSeconds < 0 ? "before" : "after"}`;
      log(`Password not accepted at ${targetLabel} (attempt ${attempts}).`);
    }

    throw new Error(`Password was not accepted during the bounded release window (${attempts} attempts).`);
  }

  async function arm() {
    stopped = false;
    armButton.disabled = true;
    try {
      const config = configFromPanel();
      if (!config.eventTitle || !config.ticketStrategy) {
        throw new Error("Event title and ticket-selection strategy are required.");
      }
      const gateVisible = Boolean(passwordGate());
      const timedGateMode =
        gateVisible &&
        config.retryGate &&
        config.releaseConfigured &&
        config.releaseAt > Date.now() - GATE_LATE_MS;

      if (timedGateMode) {
        await saveState({
          ...config,
          eventPassword: "",
          gateRetrying: true
        });
        await runReleaseGate(config);
        return;
      }

      await unlockEvent(config);
      assertEvent(config);
      const safeState = { ...config, eventPassword: "", gateRetrying: false };
      await saveState(safeState);
      await schedule(safeState, config.releaseAt > Date.now() + 1000);
    } catch (error) {
      fail(error);
    }
  }

  async function disarm() {
    stopped = true;
    clearInterval(countdownTimer);
    await clearState();
    armButton.disabled = false;
    armButton.textContent = "Run / Arm";
    log("Stopped and cleared.");
  }

  async function resetEventLocks() {
    const allStored = await chrome.storage.local.get(null);
    const prefix = `autobot-complete:${location.pathname}:`;
    const matchingKeys = Object.keys(allStored).filter((key) => key.startsWith(prefix));
    if (!matchingKeys.length) {
      log("No completed test locks exist for this event.");
      return;
    }

    const confirmed = window.confirm(
      `Clear ${matchingKeys.length} completed RSVP test lock${matchingKeys.length === 1 ? "" : "s"} for this event?\n\nOnly use this after deleting/relisting the organizer-owned test ticket and confirming the prior reservation is no longer active.`
    );
    if (!confirmed) {
      log("Test-lock reset canceled.");
      return;
    }

    stopped = true;
    clearInterval(countdownTimer);
    await clearState();
    await chrome.storage.local.remove(matchingKeys);
    armButton.disabled = false;
    armButton.textContent = "Run / Arm";
    log(`Cleared ${matchingKeys.length} completed test lock${matchingKeys.length === 1 ? "" : "s"} for this event.`);
  }

  function fail(error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`STOPPED: ${message}`);
    armButton.disabled = false;
    armButton.textContent = "Run / Arm";
    clearState().catch(() => {});
  }

  armButton.addEventListener("click", arm);
  disarmButton.addEventListener("click", disarm);
  resetLockButton.addEventListener("click", () => {
    resetEventLocks().catch(fail);
  });

  loadState().then((state) => {
    if (!state?.armed) return;
    if (state.gateRetrying) {
      clearState().catch(() => {});
      log("Password retry was interrupted by a page reload. Re-enter the password and arm again.");
      return;
    }
    $("#event-title").value = state.eventTitle;
    $("#ticket-selection").value = state.ticketStrategy || "any";
    $("#release-gate").checked = state.retryGate !== false;
    $("#execute").checked = Boolean(state.execute);
    log("Resuming the armed run after refresh.");
    schedule(state, false).catch(fail);
  });

  const detectedTitle = normalize(document.title);
  if (detectedTitle && !sameText(detectedTitle, "POSH")) {
    $("#event-title").value = detectedTitle;
  }
})();
