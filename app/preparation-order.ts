type PreparationDevice = {
  id: string;
  state: Record<string, unknown>;
};

function hostKey(device: PreparationDevice): string {
  const hostId = device.state.hostId;
  return device.state.profileMode === "multi" && typeof hostId === "string" && hostId
    ? `host:${hostId}`
    : `device:${device.id}`;
}

/**
 * Interleave workers from different physical hosts so one computer does not
 * receive every expensive preparation command back-to-back. Classic devices
 * are each treated as their own host. Input order still controls ticket-slot
 * assignment; this function controls preparation timing only.
 */
export function hostAwarePreparationOrder(
  selectedIds: string[],
  devices: PreparationDevice[],
): string[] {
  const byId = new Map(devices.map((device) => [device.id, device]));
  const originalPosition = new Map(selectedIds.map((id, index) => [id, index]));
  const groups = new Map<string, PreparationDevice[]>();

  for (const id of selectedIds) {
    const device = byId.get(id);
    if (!device) continue;
    const key = hostKey(device);
    const group = groups.get(key) ?? [];
    group.push(device);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    group.sort((left, right) => {
      const leftIndex = Number(left.state.workerIndex);
      const rightIndex = Number(right.state.workerIndex);
      if (Number.isFinite(leftIndex) && Number.isFinite(rightIndex) && leftIndex !== rightIndex) {
        return leftIndex - rightIndex;
      }
      return (originalPosition.get(left.id) ?? 0) - (originalPosition.get(right.id) ?? 0);
    });
  }

  const ordered: string[] = [];
  const queues = [...groups.values()];
  while (ordered.length < selectedIds.length) {
    let added = false;
    for (const queue of queues) {
      const next = queue.shift();
      if (!next) continue;
      ordered.push(next.id);
      added = true;
    }
    if (!added) break;
  }
  return ordered;
}
