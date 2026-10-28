import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        kvNamespaces: ["AUTH"],
        r2Buckets: ["R2_BUCKET"],
        // Dummy presigning settings: tests only inspect the signed URLs, nothing calls R2's S3 API.
        bindings: {
          S3_ENDPOINT: "https://test-account.r2.cloudflarestorage.com",
          S3_ACCESS_KEY_ID: "test-access-key-id",
          S3_SECRET_ACCESS_KEY: "test-secret-access-key",
        },
      },
    }),
  ],
});
