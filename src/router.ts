/**
 * A dependency-free path router. Patterns are `/`-separated literal segments and `:name`
 * parameters. Paths are matched on the raw (still percent-encoded) path and each parameter is
 * decoded on its own, so `%2F` inside a segment never splits it (docs/api.md 1.3).
 */

/** Decoded path parameters by name. */
export type Params = Record<string, string>;

/** A matched route: its value and the decoded parameters. */
export interface Match<T> {
  value: T;
  params: Params;
}

interface Route<T> {
  method: string;
  segments: string[];
  value: T;
}

function split(path: string): string[] {
  return path.split("/").slice(1);
}

/** Matches requests to values (handlers) by method and path pattern, in insertion order. */
export class Router<T> {
  private readonly routes: Route<T>[] = [];

  /** Adds a route, e.g. `add("GET", "/api/v1/packages/:eco/:name", handler)`. */
  add(method: string, pattern: string, value: T): this {
    if (!pattern.startsWith("/")) throw new TypeError("Patterns start with `/`.");
    this.routes.push({ method: method.toUpperCase(), segments: split(pattern), value });
    return this;
  }

  /**
   * The first route matching the method and the raw path, or `null`. A parameter segment
   * must be non-empty and correctly percent-encoded.
   */
  match(method: string, path: string): Match<T> | null {
    const segments = split(path);
    const upper = method.toUpperCase();
    for (const route of this.routes) {
      if (route.method !== upper || route.segments.length !== segments.length) continue;
      const params = matchSegments(route.segments, segments);
      if (params !== null) return { value: route.value, params };
    }
    return null;
  }
}

function matchSegments(pattern: readonly string[], segments: readonly string[]): Params | null {
  const params: Params = {};
  for (let i = 0; i < pattern.length; i++) {
    const expected = pattern[i] ?? "";
    const actual = segments[i] ?? "";
    if (!expected.startsWith(":")) {
      if (expected !== actual) return null;
      continue;
    }
    if (actual === "") return null;
    try {
      params[expected.slice(1)] = decodeURIComponent(actual);
    } catch {
      return null;
    }
  }
  return params;
}
