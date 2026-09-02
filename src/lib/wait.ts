export async function waitUntil(isoDate: string | null): Promise<void> {
  if (!isoDate) return;
  const target = new Date(isoDate).getTime();
  if (!Number.isFinite(target)) throw new Error("releaseAt must be a valid ISO date-time.");

  while (true) {
    const remaining = target - Date.now();
    if (remaining <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 1000)));
  }
}
