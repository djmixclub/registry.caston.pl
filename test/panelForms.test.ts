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
  const grantRow: [string, string][] = [
    ["grant", "0"],
    ["grant_eco", "npm"],
    ["grant_package", "x"],
    ["grant_versions", "*"],
  ];

  it("sends the grants of read and publish credentials, with no secret by default", () => {
    const { body, values } = credentialForm(
      form([
        ["project", " shop "],
        ["kind", "publish"],
        ["password", "ignored-password"],
        ...grantRow,
      ]),
    );
    expect(body).toEqual({
      project: "shop",
      kind: "publish",
      grants: [{ eco: "npm", package: "x", versions: "*", transitive: false }],
      secret: null,
    });
    expect(values).toMatchObject({ kind: "publish", firstSecret: "none", totp: false });
  });

  it("sends a generated key as the first secret, with its description", () => {
    const { body, values } = credentialForm(
      form([
        ["project", "shop"],
        ["kind", "read"],
        ["first_secret", "key"],
        ["description", " CI of the shop "],
        ["password", "ignored-for-keys"],
        ...grantRow,
      ]),
    );
    expect(body.secret).toEqual({ type: "key", description: "CI of the shop" });
    expect(values).toMatchObject({ firstSecret: "key", description: "CI of the shop" });
    expect(
      credentialForm(
        form([
          ["kind", "read"],
          ["first_secret", "key"],
        ]),
      ).body.secret,
    ).toEqual({ type: "key" });
  });

  it("sends a login with its password untrimmed, its one-time code and its description", () => {
    const { body, password, repeat, values } = credentialForm(
      form([
        ["project", "ops"],
        ["kind", "admin"],
        ["first_secret", "login"],
        ["totp", "on"],
        ["description", "Jane"],
        ["password", " correct-horse "],
        ["password_repeat", " correct-horse "],
      ]),
    );
    expect(body).toEqual({
      project: "ops",
      kind: "admin",
      secret: { type: "login", totp: true, password: " correct-horse ", description: "Jane" },
    });
    expect([password, repeat]).toEqual([" correct-horse ", " correct-horse "]);
    expect(values).toMatchObject({ firstSecret: "login", totp: true });
    // No password typed: the registry generates one.
    expect(
      credentialForm(
        form([
          ["kind", "read"],
          ["first_secret", "login"],
        ]),
      ).body.secret,
    ).toEqual({ type: "login", totp: false });
  });

  it("gives an admin a login unless it chose a key, never no secret", () => {
    expect(credentialForm(form([["kind", "admin"]])).body).toEqual({
      project: "",
      kind: "admin",
      secret: { type: "login", totp: false },
    });
    expect(
      credentialForm(
        form([
          ["kind", "admin"],
          ["first_secret", "none"],
        ]),
      ).values.firstSecret,
    ).toBe("login");
    expect(
      credentialForm(
        form([
          ["kind", "admin"],
          ["first_secret", "key"],
        ]),
      ).body.secret,
    ).toEqual({ type: "key" });
  });

  it("ignores the one-time code and the password of a first secret that is not a login", () => {
    const { body, password, values } = credentialForm(
      form([
        ["kind", "read"],
        ["first_secret", "key"],
        ["totp", "on"],
        ["password", "typed-anyway-1"],
        ...grantRow,
      ]),
    );
    expect(values.totp).toBe(false);
    expect(password).toBe("");
    expect(body.secret).toEqual({ type: "key" });
  });

  it("falls back to read for an unknown kind", () => {
    expect(credentialForm(form([["kind", "root"]])).values.kind).toBe("read");
  });
});

describe("secretForm", () => {
  it("builds a key secret with its description and expiry, and no password", () => {
    expect(secretForm(form([["type", "key"]])).body).toEqual({ type: "key" });
    const { body, password } = secretForm(
      form([
        ["type", "key"],
        ["password", "correct-horse"],
        ["description", " for CI "],
        ["expires", "2027-01-01"],
      ]),
    );
    expect(body).toEqual({ type: "key", description: "for CI", expires: "2027-01-01" });
    expect(password).toBe("");
  });

  it("builds a login secret with its optional password and one-time code", () => {
    expect(secretForm(form([["type", "login"]])).body).toEqual({ type: "login", totp: false });
    const { body, values, password, repeat } = secretForm(
      form([
        ["type", "login"],
        ["totp", "on"],
        ["password", "correct-horse-battery"],
        ["password_repeat", "correct-horse-batter"],
        ["expires", "2027-01-01"],
      ]),
    );
    expect(body).toEqual({
      type: "login",
      totp: true,
      password: "correct-horse-battery",
      expires: "2027-01-01",
    });
    expect(values).toMatchObject({ type: "login", totp: true });
    expect(password).toBe("correct-horse-battery");
    expect(repeat).toBe("correct-horse-batter");
  });

  it("sends the id of the edited gh secret only while the box to expire it is ticked", () => {
    const fields: [string, string][] = [
      ["type", "gh"],
      ["repository", "acme/shop"],
      ["edit_of", " 0123456789ab "],
      ["description", "edited"],
    ];
    const kept = secretForm(form(fields));
    expect(kept.body).not.toHaveProperty("replaces");
    expect(kept.body.description).toBe("edited");
    expect(kept.values).toMatchObject({ replaces: "0123456789ab", expire_old: false });
    const replacing = secretForm(form([...fields, ["expire_old", "on"]]));
    expect(replacing.body.replaces).toBe("0123456789ab");
    expect(replacing.values.expire_old).toBe(true);
    // Only a gh secret is edited this way.
    expect(
      secretForm(
        form([
          ["type", "key"],
          ["edit_of", "0123456789ab"],
          ["expire_old", "on"],
        ]),
      ).body,
    ).toEqual({ type: "key" });
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
