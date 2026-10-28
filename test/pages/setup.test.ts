import { describe, expect, it } from "vitest";
import { setupStatus } from "../../src/core/config";
import { firstRunPage } from "../../src/pages/firstRun";
import { setupPage } from "../../src/pages/setup";

const ctx = { host: "packages.example.com", version: "1.0.0" };
const COMPLETE = {
  SESSION_SECRET: "session-secret-value",
  S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  S3_ACCESS_KEY_ID: "access-key-value",
  S3_SECRET_ACCESS_KEY: "secret-key-value",
  PUBLIC_URL: "https://packages.example.com",
};

describe("first run without SESSION_SECRET", () => {
  const page = setupPage(ctx, setupStatus({ ...COMPLETE, SESSION_SECRET: undefined }));

  it("shows only the checklist and explains why", () => {
    expect(page).toContain("<h1>Finish the setup</h1>");
    expect(page).toContain("the panel cannot sign anyone in until");
    expect(page).not.toContain('action="/first-run"');
    expect(page).toContain('<body class="centred-page" data-page="setup">');
    expect(page).toContain(
      '<code class="setup-name">SESSION_SECRET</code> <span class="status" data-status="missing">Missing</span>',
    );
    expect(page).toContain('href="/">Check again</a>');
  });

  it("offers a value generated in the browser and the command to make one", () => {
    expect(page).toContain(
      '<button type="button" class="secondary small" data-generate hidden>Generate a value</button>',
    );
    expect(page).toContain(
      '<input type="text" class="mono" readonly spellcheck="false" aria-label="Generated value for SESSION_SECRET" data-generated-value>',
    );
    expect(page).toContain("never sent to the server");
    expect(page).toContain("<code>openssl rand -base64 48</code>");
    expect(page).toContain("<pre><code>npx wrangler secret put SESSION_SECRET</code></pre>");
    expect(page).toContain("Variables and Secrets");
  });

  it("never shows a value", () => {
    for (const value of Object.values(COMPLETE)) {
      if (value !== "https://packages.example.com") expect(page).not.toContain(value);
    }
  });
});

describe("first run with SESSION_SECRET", () => {
  it("collapses the checklist while every required setting is present", () => {
    const page = firstRunPage(ctx, { setup: setupStatus(COMPLETE) });
    expect(page).toContain(
      '<details class="setup-summary">\n<summary><span class="status" data-status="set">OK</span> All required settings are present</summary>',
    );
    expect(page).toContain('action="/first-run"');
    expect(page).not.toContain("<details open");
  });

  it("names a missing recommended setting in the summary", () => {
    const page = firstRunPage(ctx, { setup: setupStatus({ ...COMPLETE, PUBLIC_URL: "" }) });
    expect(page).toContain(
      "All required settings are present · <code>PUBLIC_URL</code> recommended</summary>",
    );
  });

  it("opens the missing S3 settings above the form, which still creates the admin", () => {
    const page = firstRunPage(ctx, {
      setup: setupStatus({ ...COMPLETE, S3_ACCESS_KEY_ID: " ", S3_SECRET_ACCESS_KEY: undefined }),
    });
    expect(page).toContain('<h2 id="setup">Settings missing</h2>');
    expect(page).toContain("publishing and downloads fail until these are set");
    expect(page).toContain("S3_ACCESS_KEY_ID");
    expect(page).not.toContain('<code class="setup-name">SESSION_SECRET</code>');
    expect(page).toContain("create the R2 API token");
    expect(page.indexOf("Settings missing")).toBeLessThan(page.indexOf('action="/first-run"'));
    expect(page).toContain('<div class="centred-box wide">');
  });
});
