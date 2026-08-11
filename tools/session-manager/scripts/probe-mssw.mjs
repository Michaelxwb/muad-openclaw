#!/usr/bin/env node
// Local probe for the mssw session adapter. Not part of the shipping CLI — use this
// to verify the signing algorithm against a live mssw endpoint during development.
//
// Usage:
//   node scripts/probe-mssw.mjs \
//     --ak <AK> --sk <SK> \
//     --url https://sitmssw.soar.sangfor.com/gateway/mss-auth-acl-service/v1/certification/login_agent \
//     [--health-endpoint /v1/rtt] \
//     [--csrf] \
//     [--agent-id local-debug] \
//     [--validate]
//
// On Windows + Git Bash, MSYS auto-converts leading-slash args like `/v1/rtt`
// to native paths (e.g. `c:/Program Files/Git/v1/rtt`). Prefix with `MSYS_NO_PATHCONV=1`
// when invoking --health-endpoint:
//   MSYS_NO_PATHCONV=1 node scripts/probe-mssw.mjs --ak ... --health-endpoint /v1/rtt --validate
//
// Prints the refresh result (cookies + expiresAt) and, when --validate is set, also
// runs the adapter's validate() against the freshly-refreshed cookies.
//
// TLS verification is skipped (mirrors main.go's InsecureSkipVerify: true) so this
// works against internal SIT environments with self-signed certs.

import { request } from "node:https";

import { MSSWSessionAdapter } from "../dist/adapters/mssw.js";

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const key = String(argv[i] ?? "");
    if (key === "--csrf") { flags.add("csrf"); continue; }
    if (key === "--validate") { flags.add("validate"); continue; }
    const normalized = key.startsWith("--") ? key.slice(2) : (key.startsWith("-") ? key.slice(1) : "");
    if (!normalized) throw new Error(`unknown argument: ${key}`);
    const value = String(argv[i + 1] ?? "");
    if (value === "" || value.startsWith("-")) throw new Error(`missing value for ${key}`);
    values.set(normalized, value);
    i += 1;
  }
  const ak = (values.get("ak") ?? "").trim();
  const sk = (values.get("sk") ?? "").trim();
  const url = (values.get("url") ?? "").trim();
  if (!ak || !sk || !url) throw new Error("--ak, --sk, --url are required");
  return {
    ak, sk, url,
    healthEndpoint: values.get("health-endpoint") ?? "",
    agentId: values.get("agent-id") ?? "local-debug",
    csrf: flags.has("csrf"),
    validate: flags.has("validate"),
  };
}

function insecureSkipVerifyFetch(input, init) {
  const url = new URL(String(input));
  const headerRecord = {};
  if (init?.headers) {
    const source = init.headers;
    if (Array.isArray(source)) {
      for (const [key, value] of source) {
        if (typeof key === "string" && typeof value === "string") headerRecord[key] = value;
      }
    } else if (source instanceof Headers) {
      source.forEach((value, key) => { headerRecord[key] = value; });
    } else {
      for (const key of Object.keys(source)) {
        if (typeof source[key] === "string") headerRecord[key] = source[key];
      }
    }
  }
  const body = init?.body === undefined ? null : (typeof init.body === "string" ? Buffer.from(init.body) : null);
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: init?.method ?? "GET",
      headers: headerRecord,
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers ?? {})) {
          if (Array.isArray(value)) value.forEach((v) => responseHeaders.append(key, v));
          else if (typeof value === "string") responseHeaders.append(key, value);
        }
        resolve(new Response(buffer, { status: res.statusCode ?? 200, headers: responseHeaders }));
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (init?.signal) init.signal.addEventListener("abort", () => req.destroy(new Error("aborted")));
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const url = new URL(parsed.url);
  const credentials = {
    baseUrl: `${url.protocol}//${url.host}`,
    sessionEndpoint: url.pathname + (url.search || ""),
    ak: parsed.ak,
    sk: parsed.sk,
    ...(parsed.csrf ? { csrfEnabled: true } : {}),
    ...(parsed.healthEndpoint ? { healthEndpoint: parsed.healthEndpoint } : {}),
  };
  const adapter = new MSSWSessionAdapter(insecureSkipVerifyFetch);
  const credential = {
    humanUserId: "local-debug",
    podId: "local-debug",
    agentId: parsed.agentId,
    skillName: "mssw-query",
    platform: "mssw",
    credentialFingerprint: "local-debug",
    credentials,
  };

  console.log("==> refresh()");
  const state = await adapter.refresh({
    credential,
    signal: new AbortController().signal,
  });
  console.log("cookies:");
  for (const cookie of state.cookies) {
    console.log(`  ${cookie.name} (len=${cookie.value.length}, domain=${cookie.domain})`);
  }
  console.log("expiresAt:", state.expiresAt);

  if (parsed.validate && parsed.healthEndpoint) {
    console.log("\n==> validate()");
    try {
      const ok = await adapter.validate({
        credential,
        state,
        signal: new AbortController().signal,
      });
      console.log("valid:", ok);
    } catch (err) {
      console.error("validate failed:", err?.message ?? err);
      console.error(`  authenticationFailed=${err?.authenticationFailed ?? "n/a"} retryable=${err?.retryable ?? "n/a"}`);
      process.exitCode = 1;
    }
  } else if (parsed.validate) {
    console.log("\n(skip validate: --health-endpoint not provided)");
  }
}

main().catch((err) => {
  console.error("probe failed:", err?.message ?? err);
  if (err?.authenticationFailed !== undefined) {
    console.error(`  authenticationFailed=${err.authenticationFailed} retryable=${err.retryable}`);
  }
  process.exit(1);
});
