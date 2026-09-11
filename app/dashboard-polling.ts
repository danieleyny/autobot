export function singleFlight<T>(operation: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (!inFlight) {
      inFlight = Promise.resolve().then(operation).finally(() => { inFlight = null; });
    }
    return inFlight;
  };
}

type VisibilitySource = {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};
type PollClock = {
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(id: number): void;
  setInterval(callback: () => void, delay: number): number;
  clearInterval(id: number): void;
};

// Control actions refresh immediately on completion. The passive dashboard view
// uses a lighter cadence, while hidden tabs make no scheduled requests.
export function startDashboardPolling(
  refresh: () => Promise<void>,
  visibility: VisibilitySource,
  clock: PollClock,
  onInitialError: (error: unknown) => void,
): () => void {
  let initialRequest = true;
  const refreshVisible = () => {
    if (visibility.visibilityState === "hidden") return;
    const reportInitialError = initialRequest;
    initialRequest = false;
    refresh().catch((error) => { if (reportInitialError) onInitialError(error); });
  };
  const initialTimer = clock.setTimeout(refreshVisible, 0);
  const timer = clock.setInterval(refreshVisible, 5_000);
  visibility.addEventListener("visibilitychange", refreshVisible);
  return () => {
    clock.clearTimeout(initialTimer);
    clock.clearInterval(timer);
    visibility.removeEventListener("visibilitychange", refreshVisible);
  };
}
