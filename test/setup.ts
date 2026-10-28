import { beforeEach } from "vitest";
import { clearCredentialCache } from "../src/core/auth";
import { clearGhRepoIndexCache } from "../src/core/ghindex";

// The isolate caches of credential records and gh-repo lists outlive a test; every test
// starts from what KV holds.
beforeEach(() => {
  clearCredentialCache();
  clearGhRepoIndexCache();
});
