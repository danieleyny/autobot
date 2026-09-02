# AUTOBOT Owned-Event RSVP Lab

This classroom project demonstrates how a one-shot browser automation flow can
reserve one free ticket from an organizer-owned test event.

It has two providers:

- `mock`: a local POSH-like event used for unrestricted development and repeatable tests.
- `posh`: a conservative adapter for one private, organizer-owned free RSVP event.

AUTOBOT v0.7.0 also includes an optional multi-device Command Center. The
hosted dashboard is currently v0.7.1. Every
device keeps the original local extension controls; pairing a device only adds
central inspection, arming, standby, stop, and audit capabilities.

The POSH adapter does not bypass OTP, CAPTCHA, queues, rate limits, purchase
limits, payments, or other controls. Live submission stays locked until the
configuration records that POSH has approved the controlled automation test.

## Set up a second computer

Use these steps when adding a friend's computer to the hosted Command Center:

1. Click **Code → Download ZIP** on GitHub, then extract the ZIP.
2. Install Google Chrome and the current Node.js LTS release.
3. Open Terminal or PowerShell inside the extracted `autobot` folder and run:

   ```bash
   npm install
   ```

4. In Chrome, open `chrome://extensions`, enable **Developer mode**, click
   **Load unpacked**, and select the extracted `extension` folder.
5. Open the [AUTOBOT Command Center](https://autobot-command-center.avgschnook.chatgpt.site),
   enter the dashboard PIN, and create a one-time pairing code.
6. On the second computer, replace `PAIRING_CODE` below and run:

   ```bash
   npm run device:pair -- \
     --controller=https://autobot-command-center.avgschnook.chatgpt.site \
     --code=PAIRING_CODE \
     --name="Friend Laptop"

   npm run device
   ```

7. Keep that terminal open. Open the organizer-owned POSH test event in Chrome,
   refresh once, and leave **Allow command center** checked in the AUTOBOT panel.
8. Confirm the device appears online, then run **Inspection** before attempting
   a controlled live test.

Pairing codes work once and expire after ten minutes. POSH sign-in, OTP,
CAPTCHA/Cloudflare checks, and event passwords remain local and manual.

## Install

```bash
npm install
npm run setup:browsers
```

## Run the local demonstration

In terminal 1:

```bash
npm run mock
```

In terminal 2, inspect without reserving:

```bash
npm run reserve
```

Reserve the single local ticket:

```bash
npm run reserve -- --execute
```

Run the automated tests:

```bash
npm test
```

Every run writes a timestamped JSONL audit log and screenshot under `artifacts/`.

## Optional Command Center

The Command Center coordinates several computers without turning them into a
multi-reservation fleet. Inspection commands may run on every selected device.
A live test creates exactly one database-backed execution lease for the chosen
primary; every other selected device receives a standby command and cannot
submit. Once the primary starts the RSVP sequence, a failure blocks the run for
manual review instead of automatically authorizing another device.

Start the controller locally:

```bash
npm run control:dev
```

Open `http://localhost:3000`, enter the dashboard PIN, and create a ten-minute
pairing code. The hosted controller is available at
`https://autobot-command-center.avgschnook.chatgpt.site` for devices that are
not on the same computer.

The hosted URL opens to an AUTOBOT PIN screen and does not require a ChatGPT
login. Successful sessions last up to twelve hours, the **Lock** button ends the
browser session immediately, and repeated incorrect PIN attempts are
temporarily blocked. The PIN and session-signing secret are stored only as
encrypted hosting secrets, not in this repository or in the browser.
On the computer being paired, run:

```bash
npm run device:pair -- \
  --controller=https://autobot-command-center.avgschnook.chatgpt.site \
  --code=REPLACE_WITH_PAIRING_CODE \
  --name="Studio Mac"

npm run device
```

After confirming the bridge connects, register it to start automatically when
that user logs in:

```bash
npm run device:install
```

This creates a user-level macOS LaunchAgent, Windows Startup entry, or Linux
desktop autostart entry. It does not require administrator access. On managed
school computers where startup entries are restricted, keep using `npm run
device` or ask IT to approve the user-level startup entry. Remove it later with
`npm run device:uninstall`.

For computers on different networks, use the deployed HTTPS Command Center URL
instead of localhost. The private device token is stored only in the ignored
`config/device.json` file. The bridge listens only on that computer's loopback
interface at `127.0.0.1:4181`.

Reload the unpacked extension after installing v0.7.0. On a POSH event page,
**Allow command center** may be enabled or disabled at any time. When disabled,
the device stays completely standalone. Even while enabled, the local **Run /
Arm** and **Stop** controls remain available; choosing local operation withdraws
that device from any pending central command.

The controller never receives the POSH login, OTP, CAPTCHA response, event
password, attendee information, or payment information. Event passwords remain
in the local page's memory, exactly as in standalone mode.

Validate the controller's primary/standby lease behavior with:

```bash
npm run test:control
```

## Prepare the organizer-owned POSH test

1. Ask POSH Support for written approval to automate one RSVP against a private,
   free event you own.
2. Create a **Free (RSVP)** event. Use an exact, unique title such as
   `AUTOBOT Classroom Test Drop`.
3. Create a free ticket named `Free Test RSVP`, set a per-account limit of one,
   and keep several tickets available while developing.
4. Prefer a private/unlisted event and do not enable payments.
5. Copy `config/posh-event.example.json` to `config/live-event.json`.
6. Fill in the exact event URL, title, ticket name, and optional ISO release time.
7. Leave `permissionConfirmed` as `false` until POSH has approved the test.

If the event is password-protected, keep `eventPasswordEnv` set to
`POSH_EVENT_PASSWORD`. Do not put the password itself in JSON or source control.
If the selected ticket is also hidden/private, keep `ticketPasswordEnv` set to
`POSH_TICKET_PASSWORD` and provide that separate value only for the current
terminal session.

## Live POSH authentication

Do not use Playwright for POSH login. POSH's Cloudflare Turnstile check rejects
the automated browser profile before OTP.

For the live classroom test:

1. Log into POSH normally in Google Chrome.
2. Complete Cloudflare and OTP yourself.
3. Load the unpacked helper from `extension/`.
4. Open the organizer-owned event in that same Chrome profile.
5. Use the AUTOBOT panel on the event page.

See [extension/README.md](extension/README.md) for installation and operation.
The helper does not run on POSH login pages and cannot access phone numbers,
email addresses, OTPs, CAPTCHA responses, or payment fields.

## Inspect the owned event

Inspection verifies the exact event title and records visible button/link labels.
It does not select a quantity or submit checkout.

```bash
POSH_EVENT_PASSWORD='your event access password' \
  POSH_TICKET_PASSWORD='your hidden ticket password' \
  npm run inspect -- --config=config/live-event.json
```

The screenshot and audit log allow the POSH adapter's selectors to be tuned to
the event's current checkout UI.

## Dry-run the POSH adapter

```bash
POSH_EVENT_PASSWORD='your event access password' \
  POSH_TICKET_PASSWORD='your hidden ticket password' \
  npm run reserve -- --config=config/live-event.json
```

The dry-run verifies:

- hostname is exactly `posh.vip`;
- path is an `/e/...` event page;
- event title exactly matches the config;
- ticket name exactly matches the config;
- the ticket is visibly marked `Free`, `RSVP`, or `$0`.

It stops before changing quantity or entering checkout.

## Execute one approved live test

Only after permission is confirmed, update `permissionConfirmed` to `true` and run:

```bash
npm run reserve -- --config=config/live-event.json --execute
```

The run is visible, selects one ticket, submits once, records the result, and exits.

## Important limitation

POSH does not publish a checkout/reservation API. Its web interface can change.
The final button selectors therefore need to be verified against your own event
immediately before the approved classroom demonstration.
