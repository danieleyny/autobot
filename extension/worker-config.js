// The standard one-laptop extension leaves this unset and continues to use the
// classic bridge on port 4181. Multi-profile setup creates a private copy of
// this extension for each Chrome worker and replaces this value locally.
globalThis.AUTOBOT_PROFILE_WORKER = null;
