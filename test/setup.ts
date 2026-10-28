import { beforeEach } from "vitest";
import { clearCredentialCache } from "../src/core/auth";
import { clearBucketCache } from "../src/core/bucket";
import { clearGhRepoIndexCache } from "../src/core/ghindex";

// The isolate caches of credential records, gh-repo lists and the bucket check outlive a test;
// every test starts from what KV and R2 hold.
beforeEach(() => {
  clearCredentialCache();
  clearGhRepoIndexCache();
  clearBucketCache();
});
