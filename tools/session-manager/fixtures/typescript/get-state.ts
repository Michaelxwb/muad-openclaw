#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const skillName: string = String(process.argv[2] ?? "");
if (!skillName) process.exit(2);

const result = spawnSync("session-manager", ["get-state", "--skill-name", skillName], {
  encoding: "utf8",
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
