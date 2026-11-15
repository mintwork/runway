// Builds the npm package:
//   dist/cli.js                 the `runway` command (AWS SDK and fflate stay npm dependencies)
//   dist/assets/functions.zip   the dispatcher Lambda functions, each fully bundled: the
//                               managed runtime's built-in SDK may not include new services
//   dist/runway.template.yaml   the CloudFormation template (for reference; the CLI embeds it)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { zipSync } from 'fflate';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
rmSync('dist', { recursive: true, force: true });
execFileSync(process.execPath, ['scripts/gen-sources.mjs'], { stdio: 'inherit' });
const define = { __RUNWAY_VERSION__: JSON.stringify(pkg.version) };

const functions = ['webhook', 'worker', 'sweeper', 'maintainer'];
const bundled = await build({
  entryPoints: Object.fromEntries(functions.map((f) => [f, `src/lambda/${f}.ts`])),
  outdir: 'dist/functions',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  minify: true,
  sourcemap: 'linked',
  legalComments: 'none',
  define,
  // Some AWS SDK dependencies still use require(); give ESM bundles a working one.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  write: false,
});
const files = {};
for (const out of bundled.outputFiles) files[out.path.split('/dist/functions/')[1]] = out.contents;
mkdirSync('dist/assets', { recursive: true });
// A fixed mtime keeps the zip byte-identical across builds of the same code.
const zip = zipSync(
  Object.fromEntries(
    Object.entries(files).map(([n, c]) => [n, [c, { mtime: new Date('2026-01-01') }]]),
  ),
);
writeFileSync('dist/assets/functions.zip', zip);

await build({
  entryPoints: ['src/cli/index.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  define,
  banner: { js: '#!/usr/bin/env node' },
});

const kb = (n) => `${Math.round(n / 1024)} KB`;
console.log(
  `dist/cli.js, dist/assets/functions.zip (${kb(zip.length)}: ${Object.keys(files)
    .filter((f) => f.endsWith('.mjs'))
    .join(', ')})`,
);
