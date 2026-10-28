import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["node_modules/", ".wrangler/", "dist/", "coverage/"] },
  js.configs.recommended,
  tseslint.configs.strict,
  tseslint.configs.stylistic,
);
