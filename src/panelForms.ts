/**
 * The two admin forms that the panel receives as form posts instead of `fetch` calls, because
 * their answer is the one-time token page: "new credential" and "add a secret". Each is read
 * into the JSON body of the matching `/api/v1` call (docs/api.md 6.15 and 6.17), which the
 * same kernel functions validate, and into the values that show the form again after an
 * error (never the passwords).
 */

import type { Eco } from "./adapters/types";
import type { Grant } from "./core/grants";
import {
  GRANT_ROLES,
  rolesOfKind,
  type CreateKind,
  type CredentialFormValues,
  type GrantRole,
  type SecretFormValues,
} from "./pages/credentials";

const CREATE_KINDS: readonly string[] = ["read", "publish", "both", "admin"];

function field(form: URLSearchParams, name: string): string {
  return (form.get(name) ?? "").trim();
}

/** The roles ticked in the `scope` boxes of a form. */
function formScope(form: URLSearchParams): GrantRole[] {
  const ticked = form.getAll("scope");
  return GRANT_ROLES.filter((role) => ticked.includes(role));
}

/**
 * The grant rows of a form: `grant` is each row's key, `grant_eco`, `grant_package` and
 * `grant_versions` follow in the same order, and `grant_transitive` lists the keys of the
 * rows whose box is ticked. Rows without a package are left out. With a `prefix` (`read_`,
 * `publish_`) the fields of that role's list are read instead.
 */
export function formGrants(form: URLSearchParams, prefix = ""): Grant[] {
  const keys = form.getAll(`${prefix}grant`);
  const ecos = form.getAll(`${prefix}grant_eco`);
  const packages = form.getAll(`${prefix}grant_package`);
  const versions = form.getAll(`${prefix}grant_versions`);
  const transitive = new Set(form.getAll(`${prefix}grant_transitive`));
  const grants: Grant[] = [];
  keys.forEach((key, i) => {
    const pkg = (packages[i] ?? "").trim();
    if (pkg === "") return;
    grants.push({
      // Checked by the kernel; here it is only shown again.
      eco: (ecos[i] ?? "") as Eco,
      package: pkg,
      versions: (versions[i] ?? "").trim() || "*",
      transitive: transitive.has(key),
    });
  });
  return grants;
}

/** The "new credential" form: the API body and the values to show again. */
export function credentialForm(form: URLSearchParams): {
  body: Record<string, unknown>;
  values: CredentialFormValues;
  password: string;
  repeat: string;
} {
  const kindField = field(form, "kind");
  const kind: CreateKind = CREATE_KINDS.includes(kindField) ? (kindField as CreateKind) : "read";
  const grants = { read: formGrants(form, "read_"), publish: formGrants(form, "publish_") };
  const scope = formScope(form);
  const project = field(form, "project");
  // A password is sent as typed, without trimming.
  const password = kind === "admin" ? (form.get("password") ?? "") : "";
  const repeat = kind === "admin" ? (form.get("password_repeat") ?? "") : "";
  const roles = rolesOfKind(kind);
  const body: Record<string, unknown> = { project, roles };
  if (kind === "admin") {
    body.secret = password === "" ? { type: "key" } : { type: "key", password };
  } else {
    // Only the lists of the roles chosen: the fields of the other one may still be filled in.
    for (const role of GRANT_ROLES) if (roles.includes(role)) body[`${role}_grants`] = grants[role];
    // Left out when nothing is ticked, so that the API says the scope is required.
    if (kind === "both" && scope.length > 0) body.secret = { type: "key", scope };
  }
  return { body, values: { project, kind, grants, scope }, password, repeat };
}

/** The "add a secret" form: the API body and the values to show again. */
export function secretForm(form: URLSearchParams): {
  body: Record<string, unknown>;
  values: SecretFormValues;
  password: string;
  repeat: string;
} {
  const values: SecretFormValues = {
    type: field(form, "type") === "gh" ? "gh" : "key",
    scope: formScope(form),
    repository: field(form, "repository"),
    repository_id: field(form, "repository_id"),
    repository_owner_id: field(form, "repository_owner_id"),
    ref: field(form, "ref"),
    workflow: field(form, "workflow"),
    environment: field(form, "environment"),
    pin_on_first_use: form.has("pin_on_first_use"),
    expires: field(form, "expires"),
  };
  const password = values.type === "key" ? (form.get("password") ?? "") : "";
  const repeat = values.type === "key" ? (form.get("password_repeat") ?? "") : "";
  const body: Record<string, unknown> =
    values.type === "key"
      ? password === ""
        ? { type: "key" }
        : { type: "key", password }
      : {
          type: "gh",
          repository: values.repository,
          repository_id: values.repository_id || null,
          repository_owner_id: values.repository_owner_id || null,
          ref: values.ref || null,
          workflow: values.workflow || null,
          environment: values.environment || null,
          pin_on_first_use: values.pin_on_first_use,
        };
  if (values.expires !== "") body.expires = values.expires;
  // Only a credential with both roles asks for a scope; the API requires it there.
  if (values.scope.length > 0) body.scope = values.scope;
  return { body, values, password, repeat };
}
