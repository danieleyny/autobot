# AUTOBOT Chrome Helper

This local, unpacked Chrome extension is the live POSH component of the
classroom project.

It deliberately does **not** run on POSH login pages and cannot read, store, or
submit phone numbers, email addresses, OTPs, CAPTCHA/Turnstile responses, or
payment information.

## Optional Command Center in v0.7.0

The normal panel remains fully standalone. If the local v0.7.0 device bridge is
running, the bottom of the panel shows the paired device name and a green
connection indicator. **Allow command center** controls whether that device may
accept central inspection, live-primary, standby, and stop commands.

Unchecking it immediately restores standalone-only operation. The local **Run /
Arm** and **Stop** buttons always remain available. If a local run replaces a
pending managed command, the controller records a local override and withdraws
the central run instead of silently allowing two executors.

The Command Center does not transmit event passwords. Enter any password on the
individual device before a centrally scheduled password-gate test. POSH login,
OTP, Cloudflare, event passwords, and completion locks all remain local.

## Install locally

1. Open normal Google Chrome.
2. Visit `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this folder:

   `/Users/danieleyny/Documents/AUTOBOT/extension`

Pin the extension from Chrome's Extensions menu if desired. Clicking its toolbar
icon opens a small popup; **Open Test Event** restores the POSH event tab if it
was closed.

## Safe workflow

1. Log into POSH normally in Chrome. Complete Cloudflare and OTP yourself.
2. Open the organizer-owned event URL in the same Chrome profile.
3. Use the AUTOBOT panel in the lower-right corner.
4. Confirm the event title and ticket-selection strategy.
5. If the event gate is visible, enter the event password in the panel. It is
   held only in page memory and cleared immediately after the gate opens.
6. Leave **Execute one free RSVP** unchecked for selector inspection.
7. Check it only for the single authorized live test.
8. Enter an optional local release time and click **Run / Arm**.

For a future password swap, leave **Four-minute password retry window (no
refresh)** checked. The helper starts at `T-2:00`, attempts every three seconds
outside the dense release window, and attempts every second from `T-0:30`
through `T+0:30`. Three-second attempts then continue through `T+2:00`.
Before each submission it clears and re-enters the prepared password because
Posh clears failed password entries. Attempts never overlap: if Posh has not
finished the previous response, missed clock targets are skipped. The page does
not refresh, and the helper stops as soon as the event opens. Password
acceptance becomes the trigger, so the RSVP sequence starts immediately even if
the gate opens before the configured clock time. The password remains only in
the current page's memory, so keep the tab open.

If the release-gate option is unchecked, the helper uses its original workflow:
it unlocks and validates the event first, waits, refreshes once at release time,
selects exactly one matching free ticket, and attempts checkout once.

Event-title comparison ignores capitalization and repeated whitespace while
still requiring a full-name match. The event title is auto-detected from the
current POSH page; `GRAND BAZAAR: PIERRE LABORDE` appears as the fallback
placeholder.

Ticket selection no longer depends on the organizer-facing ticket name. Choose
**Any available free RSVP** (the default), **First available free RSVP**, or
**Second available free RSVP**. Ordering follows POSH's visible ticket-card DOM
order. If the second strategy is selected but only one enabled free RSVP is
available, the helper uses that sole option. After selection, the helper records
the actual displayed ticket name for logs and the one-shot completion lock.

If the selected ticket becomes visibly sold out or unavailable during checkout,
the helper returns to the ticket selector and makes one bounded attempt on the
next available free RSVP. It never retries the same displayed ticket and never
attempts more than the two expected RSVP options.

POSH's current failure toast uses wording such as **out of stock**. The helper
recognizes that wording immediately. After returning to the selector, it removes
the failed ticket's retained quantity before adding the alternative, preventing
the second checkout from accidentally containing both RSVP options.

POSH may keep the first ticket's out-of-stock notification visible while the
alternative is being attempted. Before each Checkout and final RSVP submission,
the helper records the failure messages already on-screen and responds only to
new sold-out evidence. A stale notification from the first ticket therefore
cannot incorrectly mark the second ticket as unavailable.

POSH also reuses one dialog container for both the ticket selector and the
**Your Order** screen. The helper treats that dialog as the selector only while
it contains visible ticket cards. After an out-of-stock response, it can
therefore recognize the order screen, click **Back**, and wait for the actual
ticket choices before removing or selecting anything.

POSH can update the failed ticket card before it retires the old Checkout
control and its click handler. The helper now waits for the empty cart to settle
and for that old control to disappear before adding the alternative. After the
new Checkout opens, the helper verifies that **Your Order** visibly names the
newly selected ticket before it can submit the final RSVP. This prevents a
second-ticket log entry from accidentally submitting the stale first-ticket
order.

POSH may also leave a rejected final RSVP on the order page without recognizable
sold-out text. If **Your Order**, **Total Due**, and exactly one **Back** control
remain visible for three seconds after final submission, the helper treats that
unchanged order page as a stalled checkout, clicks Back, and tries the other
free RSVP once. Explicit success, duplicate, or sold-out signals are handled
immediately. If the page has navigated away or the state is ambiguous, it keeps
the safer submitted-unconfirmed stop instead.

It stops for:

- login or OTP;
- CAPTCHA/Turnstile;
- rate limiting or an anti-bot challenge;
- payment fields;
- a ticket that is not visibly free;
- missing or duplicate event/ticket matches;
- unexpected checkout fields;
- any repeat attempt on the same displayed ticket;
- more than two ticket attempts from the same armed run.

POSH may render RSVP and checkout actions as native buttons, links, or
`role="button"` controls depending on the current event layout. The helper
supports those variants, still requires an exact visible label match, and waits
briefly for the action to finish rendering after the password gate opens.
Post-password DOM checks run every 25 milliseconds; this adds no extra network
requests and keeps the visible RSVP sequence responsive while POSH renders each
step.

After the final RSVP control is clicked, the helper writes a local one-shot
completion record for that event URL and ticket name. It will not retry the same
combination, even if POSH's confirmation wording is not recognized. Verify the
result under POSH **My Orders**. Use a newly created test event for another
end-to-end demonstration.

If you delete and relist tickets on the same organizer-owned test event, use
**Reset this event's test locks** and confirm the warning. This clears completion
records only for the current event URL. Refreshing the page does not clear locks,
which prevents an accidental duplicate submission after a normal reload.
