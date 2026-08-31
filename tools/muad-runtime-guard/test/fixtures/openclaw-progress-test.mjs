#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const logFile = process.env.OPENCLAW_TEST_LOG;

if (!logFile) {
  console.error("OPENCLAW_TEST_LOG is required");
  process.exit(2);
}

if (args[0] === "message" && args[1] === "send") {
  runProgressDelivery();
} else if (args[0] === "agent" && args.includes("--deliver")) {
  runFinalDelivery();
} else {
  console.error("unsupported openclaw test invocation");
  process.exit(2);
}

function runProgressDelivery() {
  const target = argumentValue("--target");
  const channel = argumentValue("--channel");
  const message = argumentValue("--message");
  const fails = target === "foreground-owner";
  record({ kind: "progress-start", channel, target, message, at: Date.now() });
  setTimeout(() => {
    record({ kind: "progress-end", channel, target, message, ok: !fails, at: Date.now() });
    if (fails) console.error("simulated channel failure");
    process.exit(fails ? 2 : 0);
  }, fails ? 120 : 5);
}

function runFinalDelivery() {
  const deadline = Date.now() + 5_000;
  const timer = setInterval(() => {
    if (!existsSync(process.env.OPENCLAW_TEST_RELEASE_FILE ?? "")) {
      if (Date.now() < deadline) return;
      clearInterval(timer);
      console.error("final release timed out");
      process.exit(124);
    }
    clearInterval(timer);
    record({
      kind: "final",
      channel: argumentValue("--reply-channel"),
      target: argumentValue("--reply-to"),
      message: process.env.OPENCLAW_TEST_FINAL_TEXT,
      at: Date.now(),
    });
    process.exit(0);
  }, 10);
}

function argumentValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? "" : "";
}

function record(value) {
  appendFileSync(logFile, `${JSON.stringify(value)}\n`, { encoding: "utf8" });
}
