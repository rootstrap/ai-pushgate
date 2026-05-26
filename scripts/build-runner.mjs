import { build } from "esbuild";

await build({
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __pushgateCreateRequire } from "node:module";',
      "const require = __pushgateCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  bundle: true,
  entryPoints: ["src/cli.ts"],
  format: "esm",
  logLevel: "info",
  outfile: "bin/pushgate.mjs",
  platform: "node",
  target: "node20",
});
