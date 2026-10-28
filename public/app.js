// Serverless Registry panel: progressive enhancement for the server-rendered pages.
// No dependencies, no inline scripts (CSP `default-src 'self'`). Mutations are `fetch` calls
// to /api/v1 authenticated by the session cookie, followed by a reload of the page.
"use strict";

(function () {
  // --- Login: toggle between one "token" field and "login / password" fields. -------------
  // Fields of the hidden mode are disabled so they are not submitted.
  function setupLogin(form) {
    const toggle = form.querySelector("[data-login-toggle]");
    if (!toggle) return;
    toggle.hidden = false;
    function apply() {
      const checked = form.querySelector('input[name="mode"]:checked');
      const mode = checked ? checked.value : "token";
      form.querySelectorAll("[data-login-mode]").forEach(function (group) {
        const active = group.getAttribute("data-login-mode") === mode;
        group.hidden = !active;
        group.querySelectorAll("input").forEach(function (input) {
          input.disabled = !active;
        });
      });
    }
    toggle.addEventListener("change", apply);
    apply();
  }

  // --- Copy buttons copy the code block next to them. ---------------------------------------
  function copy(button) {
    const block = button.closest(".copyable");
    const code = block ? block.querySelector("code") : null;
    if (!code || !navigator.clipboard) return;
    navigator.clipboard.writeText(code.textContent).then(function () {
      const label = button.textContent;
      button.textContent = "Copied";
      setTimeout(function () {
        button.textContent = label;
      }, 1500);
    });
  }

  // --- API calls. ------------------------------------------------------------------------
  function api(method, url, body) {
    const headers = { "X-Requested-With": "fetch", Accept: "application/json" };
    const init = { method: method, headers: headers, credentials: "same-origin" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetch(url, init).then(function (response) {
      return response
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (!response.ok) {
            throw new Error(data.message || "The request failed (" + response.status + ").");
          }
          return data;
        });
    });
  }

  // A confirmation from `data-confirm`, or typing the name from `data-confirm-name`.
  function confirmed(element) {
    const message = element.getAttribute("data-confirm");
    const name = element.getAttribute("data-confirm-name");
    if (name !== null) return prompt(message) === name;
    return message === null || confirm(message);
  }

  // Shows a new token once; closing the dialog reloads the page.
  function showToken(token) {
    const dialog = document.querySelector("[data-token-dialog]");
    if (!dialog || typeof dialog.showModal !== "function") {
      prompt("This token is shown only once. Copy it now:", token);
      location.reload();
      return;
    }
    dialog.querySelector("code").textContent = token;
    dialog.addEventListener("close", function () {
      location.reload();
    });
    dialog.showModal();
  }

  function done(result) {
    if (result && typeof result.token === "string") showToken(result.token);
    else location.reload();
  }

  // --- Forms: build the JSON body of each kind of form. ----------------------------------
  function value(form, name) {
    const field = form.querySelector('[name="' + name + '"]');
    return field ? field.value.trim() : "";
  }

  function checked(form, name) {
    const field = form.querySelector('input[name="' + name + '"]:checked');
    return field ? field.value : "";
  }

  function grants(form) {
    const list = [];
    form.querySelectorAll("[data-grant-row]").forEach(function (row) {
      const field = function (name) {
        return row.querySelector('[data-field="' + name + '"]');
      };
      const pkg = field("package").value.trim();
      if (pkg === "") return;
      list.push({
        eco: field("eco").value,
        package: pkg,
        versions: field("versions").value.trim() || "*",
        transitive: field("transitive").checked,
      });
    });
    return list;
  }

  function withExpires(form, body) {
    const expires = value(form, "expires");
    if (expires !== "") body.expires = expires;
    return body;
  }

  const BODIES = {
    credential: function (form) {
      const kind = checked(form, "kind");
      const body = { project: value(form, "project"), kind: kind };
      if (kind !== "admin") body.grants = grants(form);
      return body;
    },
    grants: function (form) {
      return { grants: grants(form) };
    },
    secret: function (form) {
      if (checked(form, "type") !== "gh") return withExpires(form, { type: "key" });
      return withExpires(form, {
        type: "gh",
        repository: value(form, "repository"),
        repository_id: value(form, "repository_id") || null,
        repository_owner_id: value(form, "repository_owner_id") || null,
        ref: value(form, "ref") || null,
        workflow: value(form, "workflow") || null,
        environment: value(form, "environment") || null,
      });
    },
    expire: function (form) {
      const body = withExpires(form, {});
      return Object.keys(body).length === 0 ? undefined : body;
    },
  };

  function submit(form) {
    const error = form.querySelector("[data-form-error]");
    if (error) error.hidden = true;
    if (!confirmed(form)) return;
    const build = BODIES[form.getAttribute("data-api-form")];
    const button = form.querySelector('[type="submit"]');
    if (button) button.disabled = true;
    api(
      form.getAttribute("data-api-method"),
      form.getAttribute("data-api-url"),
      build ? build(form) : undefined,
    )
      .then(done)
      .catch(function (err) {
        if (button) button.disabled = false;
        if (error) {
          error.textContent = err.message;
          error.hidden = false;
        } else {
          alert(err.message);
        }
      });
  }

  // --- Dynamic parts of the credential forms. --------------------------------------------
  function addGrantRow(button) {
    const template = document.getElementById("grant-row");
    const rows = button.closest("[data-grants]").querySelector("[data-grant-rows]");
    if (template && rows) rows.appendChild(template.content.cloneNode(true));
  }

  function syncForm(form) {
    const grantsFieldset = form.querySelector("[data-kind] ~ [data-grants]");
    if (grantsFieldset) {
      const kind = checked(form, "kind");
      grantsFieldset.hidden = kind === "admin";
      // The stylesheet hides `transitive` (read grants only) for publish grants.
      grantsFieldset.setAttribute("data-grant-kind", kind);
    }
    const gh = form.querySelector("[data-gh-fields]");
    if (gh) gh.hidden = checked(form, "type") !== "gh";
  }

  // "Look up" fills the repository and owner ids of a gh secret from GitHub.
  function lookUp(button) {
    const form = button.closest("form");
    const error = form.querySelector("[data-form-error]");
    if (error) error.hidden = true;
    const name = value(form, "repository");
    button.disabled = true;
    api("GET", "/api/v1/github/repository?name=" + encodeURIComponent(name))
      .then(function (repository) {
        form.querySelector('[name="repository_id"]').value = repository.id;
        form.querySelector('[name="repository_owner_id"]').value = repository.ownerId;
      })
      .catch(function (err) {
        if (error) {
          error.textContent = err.message;
          error.hidden = false;
        } else {
          alert(err.message);
        }
      })
      .then(function () {
        button.disabled = false;
      });
  }

  // --- Event wiring. ---------------------------------------------------------------------
  document.addEventListener("click", function (event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const copyButton = target.closest("[data-copy]");
    if (copyButton) return copy(copyButton);
    const apiButton = target.closest("button[data-api-url]");
    if (apiButton) {
      if (!confirmed(apiButton)) return;
      apiButton.disabled = true;
      api(apiButton.getAttribute("data-api-method"), apiButton.getAttribute("data-api-url"))
        .then(done)
        .catch(function (err) {
          apiButton.disabled = false;
          alert(err.message);
        });
      return;
    }
    const lookup = target.closest("[data-gh-lookup]");
    if (lookup) return lookUp(lookup);
    const add = target.closest("[data-add-grant]");
    if (add) return addGrantRow(add);
    const remove = target.closest("[data-remove-grant]");
    if (remove) return remove.closest("[data-grant-row]").remove();
    const reload = target.closest("[data-reload]");
    if (reload) {
      const dialog = reload.closest("dialog");
      if (dialog) dialog.close();
      else location.reload();
    }
  });

  document.addEventListener("submit", function (event) {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form || !form.hasAttribute("data-api-form")) return;
    event.preventDefault();
    submit(form);
  });

  document.addEventListener("change", function (event) {
    const form = event.target instanceof Element ? event.target.closest("form") : null;
    if (form) syncForm(form);
  });

  document.querySelectorAll("[data-login]").forEach(setupLogin);
  document.querySelectorAll("form[data-api-form]").forEach(syncForm);
})();
