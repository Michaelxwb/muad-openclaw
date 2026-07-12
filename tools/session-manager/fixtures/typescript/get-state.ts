#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const platform: string = String(process.argv[2] ?? "");
if (!platform) process.exit(2);

const result = spawnSync("session-manager", ["get-state", "--platform", platform], {
  encoding: "utf8",
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
