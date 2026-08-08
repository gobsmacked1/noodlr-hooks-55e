// esbuild bundle config for the Noodlr Hooks 5.5e Foundry module.
// Bundles src/module.ts -> dist/noodlr-hooks-55e.js as an ES module (Foundry v13+ loads ESM).
// Foundry globals (game, Hooks, foundry, CONFIG, ...) are provided by the host at runtime.
//
// No code splitting and no third-party runtime dependencies: this module is pure rules logic
// against Foundry and dnd5e, so the whole thing is one small bundle.

import { build, context } from "esbuild";
import { rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");

/** Wipe dist/ before building, so a chunk that fails to emit is an honest 404 and not a stale file. */
async function cleanDist() {
  await rm("dist", { recursive: true, force: true });
}

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: { "noodlr-hooks-55e": "src/module.ts" },
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  sourcemap: true,
  // Sourcemaps ship and the bundle stays unminified on purpose: console stack traces from play are
  // the primary diagnostic channel and are worth far more than the kilobytes.
  minify: false,
  logLevel: "info",
  banner: {
    js: "/* Noodlr Hooks 5.5e for Foundry VTT. MIT. Generated bundle; edit src/. */",
  },
};

await cleanDist();

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("[noodlr-hooks] esbuild watching for changes...");
} else {
  await build(options);
  console.log("[noodlr-hooks] build complete -> dist/noodlr-hooks-55e.js");
}
