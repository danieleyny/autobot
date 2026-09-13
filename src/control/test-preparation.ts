import assert from "node:assert/strict";
import { hostAwarePreparationOrder } from "../../control-panel/app/preparation-order.js";

const selectedIds = ["host-a-1", "host-a-2", "host-a-3", "host-b-1", "host-b-2", "classic-1"];
const devices = [
  { id: "host-a-1", state: { profileMode: "multi", hostId: "host-a", workerIndex: 1 } },
  { id: "host-a-2", state: { profileMode: "multi", hostId: "host-a", workerIndex: 2 } },
  { id: "host-a-3", state: { profileMode: "multi", hostId: "host-a", workerIndex: 3 } },
  { id: "host-b-1", state: { profileMode: "multi", hostId: "host-b", workerIndex: 1 } },
  { id: "host-b-2", state: { profileMode: "multi", hostId: "host-b", workerIndex: 2 } },
  { id: "classic-1", state: {} },
];

assert.deepEqual(hostAwarePreparationOrder(selectedIds, devices), [
  "host-a-1",
  "host-b-1",
  "classic-1",
  "host-a-2",
  "host-b-2",
  "host-a-3",
]);

const reorderedInput = ["host-a-3", "host-a-1", "host-b-2", "host-b-1"];
assert.deepEqual(hostAwarePreparationOrder(reorderedInput, devices), [
  "host-a-1",
  "host-b-1",
  "host-a-3",
  "host-b-2",
]);

console.log("Host-aware preparation ordering passed: workers are interleaved across physical computers.");
