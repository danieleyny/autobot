export const AUTOBOT_VERSION = "0.13.2";
export const AUTOBOT_BUILD_ID = "v0.13.2-beta.1";
export const MIN_LIVE_PREPARATION_MS = 20_000;
export const PREPARATION_DEADLINE_LEAD_MS = 10_000;

export function profileBuildMatches(state: Record<string, unknown>): boolean {
  if (state.profileMode !== "multi") return true;
  return (
    state.hostBuildId === AUTOBOT_BUILD_ID &&
    state.extensionBuildId === AUTOBOT_BUILD_ID
  );
}
