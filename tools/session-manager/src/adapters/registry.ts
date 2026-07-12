import { HTTPSessionAdapter, type FetchLike } from "./http-session.js";
import { PlatformAdapterError, type PlatformAdapter } from "./types.js";

export const INSTALLED_ADAPTERS = ["mssw", "sdsp", "sea_soar", "soar", "xdr"] as const;

export class AdapterRegistry {
  readonly #adapters: Map<string, PlatformAdapter>;

  constructor(adapters: readonly PlatformAdapter[]) {
    this.#adapters = new Map();
    for (const adapter of adapters) {
      if (this.#adapters.has(adapter.platform)) throw new Error(`duplicate adapter: ${adapter.platform}`);
      this.#adapters.set(adapter.platform, adapter);
    }
  }

  get(name: string): PlatformAdapter {
    const adapter = this.#adapters.get(name);
    if (!adapter) throw new PlatformAdapterError();
    return adapter;
  }

  installed(): string[] {
    return [...this.#adapters.keys()].sort();
  }
}

export function createInstalledAdapterRegistry(fetchLike: FetchLike = fetch): AdapterRegistry {
  return new AdapterRegistry(INSTALLED_ADAPTERS.map((platform) => new HTTPSessionAdapter(platform, fetchLike)));
}
