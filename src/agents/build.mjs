import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

// Playwright is driven against the image's own Chromium and stays out of the bundle.
const external = ["playwright-core"];
const own = JSON.parse(readFileSync("package.json", "utf8"));

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
  external,
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});

// What the image installs next to the bundle: just the external packages, at the pinned versions.
writeFileSync(
  "dist/package.json",
  JSON.stringify(
    {
      name: "swarm-agent",
      private: true,
      type: "module",
      dependencies: Object.fromEntries(
        external.map((name) => [name, own.dependencies[name].replace(/^\^/, "")]),
      ),
    },
    null,
    2,
  ),
);
