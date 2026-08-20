import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

// node:http and node:https accept the same URL + options + callback shape; the only
// transport difference is TLS verification, which node:http ignores anyway.
function nodeRequest(
  url: URL,
  options: { method: string; headers: Record<string, string>; rejectUnauthorized?: boolean },
  onResponse: (res: IncomingMessage) => void,
): ClientRequest {
  if (url.protocol === "https:") return httpsRequest(url, options, onResponse);
  return httpRequest(url, options, onResponse);
}

/**
 * Node http/https based fetch-like transport.
 *
 * The standard global `fetch` (undici) forbids setting a custom `Host` header, but
 * the MSSW/MSSP gateways route and authenticate by `Host` (virtual-host routing in
 * nginx/OpenResty), so adapters must be able to send `Host` explicitly over plain
 * `http://` as well as `https://`. `node:http`/`node:https` both honor a `Host`
 * header in `options.headers` while still connecting to the URL's own host.
 *
 * Only string bodies are supported (the adapters send JSON or empty strings); other
 * body types are treated as an empty body. `Content-Length` is set explicitly so
 * requests use length-delimited framing like the global fetch instead of
 * `Transfer-Encoding: chunked`.
 */
export function createNodeFetch(options?: { rejectUnauthorized?: boolean }): FetchLike {
  const rejectUnauthorized = options?.rejectUnauthorized ?? true;
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
      const req = nodeRequest(url, {
        method: init?.method ?? "GET",
        headers: headerRecord,
        ...(url.protocol === "https:" ? { rejectUnauthorized } : {}),
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

// Skips TLS certificate verification: MSSW environments (SIT/UAT/prod) all use
// self-signed certificates on the internal network.
export function createInsecureFetch(): FetchLike {
  return createNodeFetch({ rejectUnauthorized: false });
}

// Strict TLS, same node transport: for adapters that keep certificate verification
// but still need to send a custom Host header (undici forbids it).
export function createSecureFetch(): FetchLike {
  return createNodeFetch({ rejectUnauthorized: true });
}
