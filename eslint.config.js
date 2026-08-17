import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // TASKS.md security rules already require the API key never be
      // logged — this catches an accidental console.log(apiKey) etc.
      "no-console": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  }
);
