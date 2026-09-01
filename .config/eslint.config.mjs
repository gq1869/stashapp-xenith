import js from "@eslint/js";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import globals from "globals";

export default [
  {
    ignores: ["dist/**", "qa/**", ".idea/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.jsx"],
    plugins: { react: reactPlugin, "react-hooks": reactHooksPlugin },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      "react/no-unknown-property": "error",
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      // Wired individually, NOT hooks.configs.flat['recommended-latest']
      // — that bundle pulls in v7's React Compiler rules (immutability on
      // refs, static-components on the async PluginApi load pattern that IS
      // this architecture), which produced 9 errors of pure noise here when
      // trialled. These two rules are the ones with real signal.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
    settings: {
      react: { version: "17.0.2" },
    },
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        // Vite `define` literal (vite.config.js) - see globals.d.ts for the
        // matching ambient type declaration.
        __XENITH_CHANNEL__: "readonly",
      },
    },
  },
];
