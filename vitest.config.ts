import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        kvNamespaces: ["AUTH"],
        r2Buckets: ["R2_BUCKET"],
        // The installation settings a deployment sets in the dashboard. `wrangler.jsonc` has no
        // `vars` (defaults live in src/core/config.ts), so the tests set them explicitly.
        bindings: {
          MAX_UPLOAD_BYTES: "536870912",
          CHECK_UPDATES: "true",
          TOKEN_PREFIX: "",
          R2_BUCKET_NAME: "serverless-registry",
          ECOSYSTEMS: "composer,npm,cargo,generic,nuget,swift,maven",
          APPEND_WINDOW_HOURS: "24",
          // Dummy presigning settings: tests only inspect the signed URLs, nothing calls R2's S3 API.
          S3_ENDPOINT: "https://test-account.r2.cloudflarestorage.com",
          S3_ACCESS_KEY_ID: "test-access-key-id",
          S3_SECRET_ACCESS_KEY: "test-secret-access-key",
          SESSION_SECRET: "test-session-secret-not-for-production",
        },
      },
    }),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
});
