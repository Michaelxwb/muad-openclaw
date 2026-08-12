import { request } from "node:https";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Build a fetch-like function that skips TLS certificate verification.
 *
 * MSSW environments (SIT/UAT/prod) all use self-signed certificates on the internal
 * network, so the mssw adapter always goes through this fetch. Other adapters keep
 * strict TLS via the global fetch.
 *
 * The standard global `fetch` (undici) does not accept a per-request `rejectUnauthorized`
 * flag, so we drop down to `node:https` and reassemble a `Response` to stay fetch-shaped.
 * Only string bodies are supported (the mssw adapter sends an empty string); other body
 * types are treated as an empty body. `Content-Length` is set explicitly so requests use
 * length-delimited framing like the global fetch instead of `Transfer-Encoding: chunked`.
 */
export function createInsecureFetch(): FetchLike {
  return async (input, init) => {
    const url = new URL(String(input));
    const headerRecord: Record<string, string> = {};
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
          const value = source[key];
          if (typeof value === "string") headerRecord[key] = value;
        }
      }
    }
    const bodyString = typeof init?.body === "string" ? init.body : null;
    const body = bodyString === null ? null : Buffer.from(bodyString);
    if (bodyString !== null) headerRecord["Content-Length"] = String(Buffer.byteLength(bodyString));
    return new Promise<Response>((resolve, reject) => {
      const req = request(url, {
        method: init?.method ?? "GET",
        headers: headerRecord,
        rejectUnauthorized: false,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
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
      if (init?.signal) {
        init.signal.addEventListener("abort", () => req.destroy(new Error("aborted")));
      }
      if (body) req.write(body);
      req.end();
    });
  };
}
