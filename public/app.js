// Serverless Registry panel: progressive enhancement for the server-rendered pages.
// No dependencies, no inline scripts (CSP `default-src 'self'`).
"use strict";

(function () {
  // Login: toggle between one "token" field and "login / password" fields. Fields of the
  // hidden mode are disabled so they are not submitted.
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

  // "Copy" buttons copy the code block next to them.
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

  document.addEventListener("click", function (event) {
    const target = event.target instanceof Element ? event.target : null;
    const button = target ? target.closest("[data-copy]") : null;
    if (button) copy(button);
  });

  document.querySelectorAll("[data-login]").forEach(setupLogin);
})();
