import { build } from "esbuild";

await build({
  entryPoints: { main: "src/main.ts" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  minify: false,
});
