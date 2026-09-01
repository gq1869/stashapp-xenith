import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  // Classic JSX runtime: oxc compiles <div/> to React.createElement(...) and
  // <>…</> to React.Fragment, with no auto-injected import. Every component
  // already does `const { React } = window.PluginApi;` at module top, so
  // that identifier is in lexical scope — which is why React is never
  // bundled and never resolved from node_modules. No plugin, no alias, no
  // shim (contrast with the old esbuild pluginapi-externals plugin).
  oxc: { jsx: { runtime: "classic" } },
  // Bakes the release channel in as a literal so `mode === "canary"` build
  // strips dead-code in the stable bundle (see main.js's canary chip) -
  // stable ships zero extra bytes for a check it will never take.
  define: {
    __XENITH_CHANNEL__: JSON.stringify(mode === "canary" ? "canary" : "stable"),
  },
  build: {
    target: "es2020",
    minify: mode !== "development",
    sourcemap: mode === "development",
    lib: {
      entry: "src/main.js",
      // Required by Vite whenever formats include iife, even though the
      // bundle exports nothing.
      name: "Xenith",
      // iife because Stash injects dist/xenith.js as a classic <script>.
      formats: ["iife"],
      // xenith.yml pins both output names; neither may be hashed.
      fileName: () => "xenith.js",
      cssFileName: "xenith",
    },
  },
}));
