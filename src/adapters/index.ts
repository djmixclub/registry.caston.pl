/**
 * The adapter registry: one {@link Adapter} per ecosystem, created on first use. Only the
 * ecosystems enabled by the `ECOSYSTEMS` variable are routed and listed ({@link getAdapter},
 * {@link enabledAdapters}); {@link ADAPTERS} itself holds every ecosystem, so stored data of a
 * disabled ecosystem (grants, manifests) stays readable.
 */

import { enabledEcosystems } from "../core/config";
import type { Env } from "../env";
import { composerAdapter } from "./composer/index";
import { npmAdapter } from "./npm/index";
import { placeholderAdapter } from "./placeholder";
import { ECOS, isEco, type Adapter, type Eco } from "./types";

const FACTORIES: Readonly<Record<Eco, () => Adapter>> = {
  composer: () => composerAdapter,
  npm: () => npmAdapter,
  cargo: () => placeholderAdapter("cargo"),
  generic: () => placeholderAdapter("generic"),
  nuget: () => placeholderAdapter("nuget"),
};

const created = new Map<Eco, Adapter>();

function load(eco: Eco): Adapter {
  let adapter = created.get(eco);
  if (adapter === undefined) {
    adapter = FACTORIES[eco]();
    created.set(eco, adapter);
  }
  return adapter;
}

/** Every adapter, enabled or not, each built lazily on first access. */
export const ADAPTERS: Readonly<Record<Eco, Adapter>> = Object.freeze(
  Object.defineProperties(
    {} as Record<Eco, Adapter>,
    Object.fromEntries(
      ECOS.map((eco) => [eco, { enumerable: true, get: () => load(eco) }]),
    ) as PropertyDescriptorMap,
  ),
);

/** The adapter of `eco` when it names an ecosystem enabled by `ECOSYSTEMS`, else `null`. */
export function getAdapter(env: Pick<Env, "ECOSYSTEMS">, eco: string): Adapter | null {
  return isEco(eco) && enabledEcosystems(env).includes(eco) ? ADAPTERS[eco] : null;
}

/** The adapters of the enabled ecosystems, in the canonical order. */
export function enabledAdapters(env: Pick<Env, "ECOSYSTEMS">): Adapter[] {
  return enabledEcosystems(env).map((eco) => ADAPTERS[eco]);
}

/**
 * Whether a grant's version constraint is valid for an ecosystem (the adapter's
 * `validateRange`), as `validateGrant` expects it.
 */
export function validateRange(eco: Eco, constraint: string): boolean {
  return ADAPTERS[eco].validateRange(constraint);
}
