import { describe, expect, it } from "vitest";
import { credentialForm, formGrants, secretForm } from "../src/panelForms";

function form(fields: [string, string][]): URLSearchParams {
  return new URLSearchParams(fields);
}

describe("formGrants", () => {
  it("pairs each ticked transitive box with its row by key and skips empty rows", () => {
    const grants = formGrants(
      form([
        ["grant", "0"],
        ["grant_eco", "npm"],
        ["grant_package", " @acme/* "],
        ["grant_versions", ""],
        ["grant", "added-1"],
        ["grant_eco", "composer"],
        ["grant_package", ""],
        ["grant_versions", "*"],
        ["grant_transitive", "added-1"],
        ["grant", "added-2"],
        ["grant_eco", "composer"],
        ["grant_package", "acme/sdk"],
        ["grant_versions", "^1.0"],
        ["grant_transitive", "added-2"],
      ]),
    );
    expect(grants).toEqual([
      { eco: "npm", package: "@acme/*", versions: "*", transitive: false },
      { eco: "composer", package: "acme/sdk", versions: "^1.0", transitive: true },
    ]);
  });
});

describe("credentialForm", () => {
  it("sends the grants of read and publish credentials", () => {
    const { body, values } = credentialForm(
      form([
        ["project", " shop "],
        ["kind", "publish"],
        ["password", "ignored-password"],
        ["grant", "0"],
        ["grant_eco", "npm"],
        ["grant_package", "x"],
        ["grant_versions", "*"],
      ]),
    );
    expect(body).toEqual({
      project: "shop",
      kind: "publish",
      grants: [{ eco: "npm", package: "x", versions: "*", transitive: false }],
    });
    expect(values.kind).toBe("publish");
  });

  it("sends an admin password as the first secret, untrimmed", () => {
    const { body, password, repeat } = credentialForm(
      form([
        ["project", "ops"],
        ["kind", "admin"],
        ["password", " correct-horse "],
        ["password_repeat", " correct-horse "],
      ]),
    );
    expect(body).toEqual({
      project: "ops",
      kind: "admin",
      secret: { type: "key", password: " correct-horse " },
    });
    expect([password, repeat]).toEqual([" correct-horse ", " correct-horse "]);
    expect(credentialForm(form([["kind", "admin"]])).body).toEqual({
      project: "",
      kind: "admin",
      secret: { type: "key" },
    });
  });

  it("falls back to read for an unknown kind", () => {
    expect(credentialForm(form([["kind", "root"]])).values.kind).toBe("read");
  });
});

describe("secretForm", () => {
  it("builds a key secret with its password and expiry", () => {
    expect(secretForm(form([["type", "key"]])).body).toEqual({ type: "key" });
    expect(
      secretForm(
        form([
          ["type", "key"],
          ["password", "correct-horse"],
          ["expires", "2027-01-01"],
        ]),
      ).body,
    ).toEqual({ type: "key", password: "correct-horse", expires: "2027-01-01" });
  });

  it("builds a gh secret with empty claims as null and pin_on_first_use from the box", () => {
    const { body, values, password } = secretForm(
      form([
        ["type", "gh"],
        ["repository", " acme/shop "],
        ["repository_id", "123"],
        ["repository_owner_id", ""],
        ["ref", "refs/tags/v*"],
        ["password", "not-for-gh"],
      ]),
    );
    expect(body).toEqual({
      type: "gh",
      repository: "acme/shop",
      repository_id: "123",
      repository_owner_id: null,
      ref: "refs/tags/v*",
      workflow: null,
      environment: null,
      pin_on_first_use: false,
    });
    expect(password).toBe("");
    expect(values.pin_on_first_use).toBe(false);
    expect(
      secretForm(
        form([
          ["type", "gh"],
          ["pin_on_first_use", "on"],
        ]),
      ).body,
    ).toMatchObject({
      pin_on_first_use: true,
    });
  });
});
