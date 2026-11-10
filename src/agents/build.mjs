import { build } from "esbuild";

// Two entry points from one image: the agent task and the scope proxy sidecar.
await build({
  entryPoints: { task: "src/task-main.ts", proxy: "src/proxy-main.ts" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  minify: true,
  sourcemap: false,
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});
