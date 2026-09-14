import { readFile } from "node:fs/promises";
import path from "node:path";
import { profileHostConfigPath } from "./profile-host-options.js";

const reportFile = path.join(path.dirname(profileHostConfigPath()), "profile-host-performance.json");
try {
  console.log(await readFile(reportFile, "utf8"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error("No local performance report exists yet. Open every worker event page and run Calibrate host in the Command Center.");
  }
  throw error;
}
