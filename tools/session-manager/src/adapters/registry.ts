import { HTTPSessionAdapter, type FetchLike } from "./http-session.js";
import { MSSWSessionAdapter } from "./mssw.js";
import { SmokePlatformSessionAdapter } from "./smoke-platform.js";
import { PlatformAdapterError, type PlatformAdapter } from "./types.js";
import { PLATFORM_PATTERN } from "../constants/runtime.js";

type AdapterFactory = (platform: string) => PlatformAdapter;

export class AdapterRegistry {
  readonly #adapters: Map<string, PlatformAdapter>;
  readonly #fallbackFactory: AdapterFactory | undefined;

  constructor(adapters: readonly PlatformAdapter[], fallbackFactory?: AdapterFactory) {
    this.#adapters = new Map();
    this.#fallbackFactory = fallbackFactory;
    for (const adapter of adapters) {
      if (this.#adapters.has(adapter.platform)) throw new Error(`duplicate adapter: ${adapter.platform}`);
      this.#adapters.set(adapter.platform, adapter);
    }
  }

  get(name: string): PlatformAdapter {
    const platform = name.trim();
    const adapter = this.#adapters.get(platform) ?? this.#createFallback(platform);
    return adapter;
  }

  installed(): string[] {
    return [...this.#adapters.keys()].sort();
  }

  #createFallback(platform: string): PlatformAdapter {
    if (!this.#fallbackFactory || !PLATFORM_PATTERN.test(platform)) throw new PlatformAdapterError();
    const adapter = this.#fallbackFactory(platform);
    if (adapter.platform !== platform) throw new PlatformAdapterError();
    this.#adapters.set(platform, adapter);
    return adapter;
  }
}

export function createInstalledAdapterRegistry(fetchLike: FetchLike = fetch): AdapterRegistry {
  return new AdapterRegistry(
    [new MSSWSessionAdapter(fetchLike), new SmokePlatformSessionAdapter(fetchLike)],
    (platform) => new HTTPSessionAdapter(platform, fetchLike),
  );
}
