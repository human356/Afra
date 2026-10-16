// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "data/**", "coverage/**", "plugins/**", "scripts/*.cjs"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": ["error", { allow: ["error"] }],
      eqeqeq: ["error", "always"],
    },
  },
  {
    files: ["src/dashboard/public/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: { document: "readonly", fetch: "readonly", location: "readonly", alert: "readonly", setInterval: "readonly", clearInterval: "readonly", window: "readonly" },
    },
  },
  { files: ["src/cli.ts", "scripts/**/*.ts", "tests/**/*.ts"], rules: { "no-console": "off" } },
);
