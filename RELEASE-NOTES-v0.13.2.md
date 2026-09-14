# AUTOBOT v0.13.2-beta.1

This is an isolated performance beta for the multi-profile host. The v0.12.2
classic production dashboard remains available as the rollback path.

## What changed

- Prepared execution capsule: release uses the exact preflight-verified ticket
  card and add control without repeating a whole-page ticket scan.
- Release quiet mode: nonessential controller polling, dashboard refreshes,
  storage writes, status rendering, and panel logs pause from T-2 seconds through
  the protected submission window. Local timing remains authoritative.
- Real 20-second host calibration measures event-loop lag, browser frame gap,
  DOM scan time, and minimum free memory across all configured profiles.
- A recent calibration automatically limits how many profiles may be selected
  on that physical host.
- Optional 15ms same-host release lanes are available for controlled A/B tests;
  they are off by default and should remain off unless mock-event results prove
  a benefit.
- Double-click Mac and Windows launchers start the local profile host if needed
  and open only missing Chrome profiles.
- Every extension can copy a local-only performance report with phase durations.

## Safety retained

One-use leases and local completion locks remain enforced. AUTOBOT still stops
for login, OTP, CAPTCHA/Cloudflare, payment UI, hidden event tabs, ambiguous
ticket controls, mixed extension builds, or an expired preparation deadline.
