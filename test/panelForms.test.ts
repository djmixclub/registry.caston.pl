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
        ["publish_grant", "0"],
        ["publish_grant_eco", "npm"],
        ["publish_grant_package", "x"],
        ["publish_grant_versions", "*"],
        // The list of a role the credential does not hold is left out, even when filled in.
        ["read_grant", "0"],
        ["read_grant_eco", "npm"],
        ["read_grant_package", "ignored"],
        ["read_grant_versions", "*"],
      ]),
    );
    expect(body).toEqual({
      project: "shop",
      roles: ["publish"],
      publish_grants: [{ eco: "npm", package: "x", versions: "*", transitive: false }],
    });
    expect(values.kind).toBe("publish");
  });

  it("sends both lists and the scope of the first token for read + publish", () => {
    const { body, values } = credentialForm(
      form([
        ["project", "dual"],
        ["kind", "both"],
        ["scope", "read"],
        ["read_grant", "0"],
        ["read_grant_eco", "npm"],
        ["read_grant_package", "@acme/*"],
        ["read_grant_versions", "*"],
        ["read_grant_transitive", "0"],
        ["publish_grant", "0"],
        ["publish_grant_eco", "npm"],
        ["publish_grant_package", "@acme/sdk"],
        ["publish_grant_versions", "*"],
      ]),
    );
    expect(body).toEqual({
      project: "dual",
      roles: ["read", "publish"],
      read_grants: [{ eco: "npm", package: "@acme/*", versions: "*", transitive: true }],
      publish_grants: [{ eco: "npm", package: "@acme/sdk", versions: "*", transitive: false }],
      secret: { type: "key", scope: ["read"] },
    });
    expect(values.scope).toEqual(["read"]);
  });

  it("leaves the secret out when no scope is ticked, so that the API asks for one", () => {
    const { body } = credentialForm(
      form([
        ["project", "dual"],
        ["kind", "both"],
      ]),
    );
    expect(body).not.toHaveProperty("secret");
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
      roles: ["admin"],
      secret: { type: "key", password: " correct-horse " },
    });
    expect([password, repeat]).toEqual([" correct-horse ", " correct-horse "]);
    expect(credentialForm(form([["kind", "admin"]])).body).toEqual({
      project: "",
      roles: ["admin"],
      secret: { type: "key" },
    });
  });

  it("falls back to read for an unknown kind", () => {
    expect(credentialForm(form([["kind", "root"]])).values.kind).toBe("read");
  });
});

describe("secretForm", () => {
  it("sends the ticked scope", () => {
    const { body, values } = secretForm(
      form([
        ["type", "key"],
        ["scope", "publish"],
        ["scope", "read"],
      ]),
    );
    expect(body).toEqual({ type: "key", scope: ["read", "publish"] });
    expect(values.scope).toEqual(["read", "publish"]);
    expect(secretForm(form([["type", "key"]])).body).not.toHaveProperty("scope");
  });

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
