import type { Env as WorkerEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    // `env` from `cloudflare:workers` (and `cloudflare:test`) is typed as `Cloudflare.Env`.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends WorkerEnv {}

    // Types `exports` from `cloudflare:workers` with the Worker's own entry points.
    interface GlobalProps {
      mainModule: typeof import("../src/index");
    }
  }
}
