#!/usr/bin/env bun
/**
 * Post-build processing for Vite build output.
 *
 * 1. Patch globalThis.Bun destructuring in third-party deps for Node.js compat
 * 2. Copy native addon files
 * 3. Generate dual entry points (cli-bun.js, cli-node.js)
 */
import { readdir, readFile, writeFile, cp } from "node:fs/promises";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { patchNodeFetchWithNativeFetch } from "./bundle-compat.ts";
import { DEFAULT_BUILD_FEATURES, getMacroDefines } from "./defines.ts";

const outdir = "dist";

async function postBuild() {
  const supportResult = await Bun.build({
    entrypoints: [
      "scripts/gen-poc-catalog.ts",
      "scripts/redscope-proxy-scrape.ts",
    ],
    outdir: join(outdir, "scripts"),
    target: "bun",
    splitting: true,
    define: getMacroDefines(),
    features: [...DEFAULT_BUILD_FEATURES],
  });
  if (!supportResult.success) {
    throw new Error(
      `Support script build failed: ${supportResult.logs.join("\n")}`,
    );
  }

  // Step 1: Patch globalThis.Bun destructuring from third-party deps
  const files = await readdir(outdir, { recursive: true });
  const BUN_DESTRUCTURE = /var \{([^}]+)\} = globalThis\.Bun;?/g;
  const BUN_DESTRUCTURE_SAFE =
    'var {$1} = typeof globalThis.Bun !== "undefined" ? globalThis.Bun : {};';

  let bunPatched = 0;
  let fetchPatched = 0;
  for (const file of files) {
    const filePath = join(outdir, file);
    if (typeof file !== "string" || !file.endsWith(".js")) continue;
    const content = await readFile(filePath, "utf-8");
    const bunCompatible = content.replace(
      BUN_DESTRUCTURE,
      (_match, destructured: string) => {
        bunPatched++;
        return BUN_DESTRUCTURE_SAFE.replace("$1", destructured);
      },
    );
    const fetchCompatible =
      patchNodeFetchWithNativeFetch(bunCompatible);
    fetchPatched += fetchCompatible.patched;
    if (fetchCompatible.content !== content) {
      await writeFile(filePath, fetchCompatible.content);
    }
  }

  // Step 2: Copy native addon files
  const audioCaptureDir = join(outdir, "vendor", "audio-capture");
  await cp("vendor/audio-capture", audioCaptureDir, { recursive: true } as never);
  console.log(`Copied vendor/audio-capture/ → ${audioCaptureDir}/`);

  const ripgrepDir = join(outdir, "vendor", "ripgrep");
  await cp("src/utils/vendor/ripgrep", ripgrepDir, { recursive: true } as never);
  console.log(`Copied src/utils/vendor/ripgrep/ → ${ripgrepDir}/`);

  // Step 3: Generate dual entry points
  const cliBun = join(outdir, "cli-bun.js");
  const cliNode = join(outdir, "cli-node.js");

  await writeFile(
    cliBun,
    '#!/usr/bin/env -S bun --no-env-file\nimport "./cli.js"\n',
  );
  await writeFile(cliNode, '#!/usr/bin/env node\nimport "./cli.js"\n');

  chmodSync(cliBun, 0o755);
  chmodSync(cliNode, 0o755);

  console.log(
    `Post-build complete: bundled ${supportResult.outputs.length} support files, patched ${bunPatched} Bun destructure and ${fetchPatched} native fetch references, generated entry points`,
  );
}

postBuild().catch((err) => {
  console.error("Post-build failed:", err);
  process.exit(1);
});
