// `npm run build --workspace=apps/server`: bundles the server into dist/server.js, which
// `npm start` runs with plain Node (no tsx). Our workspace packages (@testify/core,
// @testify/db) are TypeScript source, so they're bundled in; every other dependency stays
// external and is loaded from node_modules at run time.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// Start from an empty dist/ so nothing from an older build lingers.
rmSync(here('../dist'), { recursive: true, force: true });

await build({
  entryPoints: [here('../src/server.ts')],
  outfile: here('../dist/server.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  plugins: [
    {
      name: 'external-dependencies',
      setup(b) {
        // Bare imports (packages): external, except our own workspace packages.
        b.onResolve({ filter: /^[^./]/ }, (args) =>
          args.path.startsWith('@testify/') ? undefined : { path: args.path, external: true }
        );
      },
    },
  ],
});
