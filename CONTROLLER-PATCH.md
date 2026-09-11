# AUTOBOT Command Center 0.12.2

The two-slot fleet allocation is compatible with existing v0.11.x laptop
packages: the controller now assigns each selected device either the first or
second displayed free RSVP and records that target with the run. Updating the
device package to v0.12.2 adds prepared release, foreground protection,
local-only timing diagnostics, and the fleet-reset improvements;
saved pairings remain valid.

- Identical device polls update their stored presence at most every five seconds.
  Status, mode, version, and encryption-key changes still persist immediately.
  The conditional SQL is shared across concurrent requests and Worker instances.
- Legacy bridges keep a 12.5-second online window. v0.12.2 bridges report their
  current interval, so the controller derives a 2.5x grace window and does not
  mark a healthy 15-second idle bridge offline.
- Visible dashboards use a five-second passive refresh rate. Control actions
  refresh immediately. Hidden tabs
  skip scheduled refreshes and refresh immediately on return. Concurrent
  refreshes share one request. Forms and selections are not reset by hiding.
- Late Stop or failure reports cannot overwrite a submitted or confirmed result.
- Idle bridges poll every 15 seconds. Opening an event page or receiving a
  pending command wakes one-second polling immediately.
- Live commands are acknowledged before release, and the RSVP path never waits
  for the controller or D1 at the exact release moment.
- Live activation staggers preflight page work by up to 30 seconds, opens the
  ticket selector, verifies the assigned free slot and completion lock, then
  holds that prepared state without changing quantity until the local clock
  reaches release.
- Live activation requires the POSH event tab to be visible. The extension
  focuses it on receipt and stops if it becomes hidden before completion.
- Device performance timelines remain in local extension storage and are never
  returned to the controller.
- The central reset command stops the active run, supersedes older queued
  commands, clears local event locks, and leaves selected devices ready to arm
  again.

The earlier presence-write coalescing and hidden-dashboard polling protections
remain in place. Existing older bridges retain their pairings, but v0.12.2 is
required for prepared live activation.

Validation: `npm run test:presence`, `npm run test:control`, `npm test`,
`npm run typecheck`, controller lint/typecheck/build. Tests must target a local
controller, never the production fleet. Production verification is limited to
reading the controller revision, paired-device IDs, online state, and active runs.

The presence/polling tests, local API integration, Playwright
tests, root typecheck, controller lint, and production build passed. Standalone
controller `tsc` still reports two pre-existing type errors in `app/pin-auth.ts`
and `vite.config.ts`; both were reproduced from the unchanged version-9 source
in an isolated temporary checkout. No errors were introduced by this patch.

There are no schema or credential changes in this release. Device updates
preserve existing pairings, but the bridge and unpacked extension must both be
reloaded from the v0.12.2 package.
