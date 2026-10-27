import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const testOnly = process.argv.includes('--test');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  sourcemap: production ? false : 'inline',
  logLevel: 'info',
  target: 'node20',
};

async function buildExtension() {
  const options = {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    minify: production,
  };

  if (watch) {
    const context = await esbuild.context(options);
    await context.watch();
    console.log('[watch] extension bundle');
    return context;
  }

  await esbuild.build(options);
  return undefined;
}

async function buildTests() {
  await esbuild.build({
    ...common,
    entryPoints: ['test/core.test.ts'],
    outfile: 'dist-test/core.test.cjs',
    platform: 'node',
    format: 'cjs',
    minify: false,
  });
}

const context = testOnly ? undefined : await buildExtension();
await buildTests();

if (watch && context) {
  await new Promise(() => {});
}
