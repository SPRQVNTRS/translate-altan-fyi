import type { AnyConfig } from "#app/cms/types";

/**
 * Content collections and datasets, keyed by collection name.
 * Register a collection here to make it loadable through `#app/cms/loader.server`.
 */
export const registry: Record<string, AnyConfig> = {};

export type Registry = typeof registry;
