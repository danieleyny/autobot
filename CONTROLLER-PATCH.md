# Controller-only presence patch: 0.11.1-presence.1

This pre-trial patch is compatible with the existing v0.11.1 laptop packages.
No bridge/extension update, restart, re-pairing, credential rotation, database
migration, event change, or lease change is required.

- Identical device polls update their stored presence at most every five seconds.
  Status, mode, version, and encryption-key changes still persist immediately.
  The conditional SQL is shared across concurrent requests and Worker instances.
- All three online checks share a 12.5-second window: five seconds of possible
  persisted-presence age plus the existing 7.5-second connection grace. This
  avoids false offline readings from write coalescing. Actual disconnects can
  take up to five additional seconds to display.
- Visible dashboards keep the existing two-second refresh rate. Hidden tabs
  skip scheduled refreshes and refresh immediately on return. Concurrent
  refreshes share one request. Forms and selections are not reset by hiding.
- Device command polling, acknowledgments, immediate reports, local controls,
  password timing, and live execution authorization are unchanged.

Limit: this reduces steady-state device row updates by approximately 80%, plus
hidden-dashboard traffic. It does NOT reduce existing bridges' one-second HTTP
request rate or guarantee compliance with any hosting quota. An adaptive bridge
upgrade remains a separate post-trial change requiring device updates and
extended tests. Keep production capacity monitoring separate from this patch.

Validation: `npm run test:presence`, `npm run test:control`, `npm test`,
`npm run typecheck`, controller lint/typecheck/build. Tests must target a local
controller, never the production fleet. Production verification is limited to
reading the controller revision, paired-device IDs, online state, and active runs.

The six presence/polling tests, local API integration, seven existing Playwright
tests, root typecheck, controller lint, and production build passed. Standalone
controller `tsc` still reports two pre-existing type errors in `app/pin-auth.ts`
and `vite.config.ts`; both were reproduced from the unchanged version-9 source
in an isolated temporary checkout. No errors were introduced by this patch.

Rollback: redeploy saved Sites version 9 (source commit
8961055226fe8b497bc48bdab485cc6a870b1b32). There are no schema or credential
changes to undo. No automatic device-upgrade or restart operation is included.
