import * as esbuild from 'esbuild'
import * as path from 'path'

const isWatch = process.argv.includes('--watch')
const isProduction = process.argv.includes('--production')

/** @type {import('esbuild').BuildOptions} */
const sharedOptions = {
  bundle: true,
  platform: 'node',
  // target must stay in sync with engines.node in package.json
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  minify: isProduction,
  // Only vscode needs explicit externalization. platform: 'node' auto-externalizes
  // Node.js built-ins (fs, path, node:sqlite, etc.). All npm dependencies are
  // inlined into the bundle — the VSIX ships no node_modules.
  external: ['vscode'],
  // mobbdev_src is a symlink to ../../cli/src. When esbuild follows it, module
  // resolution starts from clients/cli/ which may lack tracer_ext's deps.
  // nodePaths provides a fallback so those deps are still found here.
  nodePaths: [path.resolve('node_modules')],
  // `jsonc-parser`'s UMD `main` uses dynamic `require('./impl/...')` that
  // esbuild can't statically trace, which breaks at runtime with
  // "Cannot find module './impl/format'". Alias to the ESM entry which is
  // fully analyzable. Narrow alias (not mainFields: ['module', 'main'])
  // because global ESM-first resolution breaks CJS-default-import interop
  // in other deps (e.g. `bitbucket`).
  alias: {
    'jsonc-parser': path.resolve('node_modules/jsonc-parser/lib/esm/main.js'),
  },
}

// Main extension entry point
const mainBuild = {
  ...sharedOptions,
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
}

// DB worker runs in a separate Worker thread — must be a separate bundle.
// Loaded at runtime via: new Worker(path.join(__dirname, 'dbWorker.js'))
const dbWorkerBuild = {
  ...sharedOptions,
  entryPoints: ['src/cursor/dbWorker.ts'],
  outfile: 'out/dbWorker.js',
}

// Copilot read worker — handles JSONL file I/O + line splitting off the
// extension host main thread. Loaded at runtime via:
//   new Worker(path.join(__dirname, 'readWorker.js'))
const copilotReadWorkerBuild = {
  ...sharedOptions,
  entryPoints: ['src/copilot/readWorker.ts'],
  outfile: 'out/readWorker.js',
}

// Loaded at runtime via: new Worker(path.join(__dirname, 'contextFileWorker.js'))
const contextFileWorkerBuild = {
  ...sharedOptions,
  entryPoints: ['src/shared/contextFileWorker.ts'],
  outfile: 'out/contextFileWorker.js',
}

const allBuilds = [mainBuild, dbWorkerBuild, copilotReadWorkerBuild, contextFileWorkerBuild]

try {
  if (isWatch) {
    // Note: watch mode only bundles — it does not type-check.
    // Use your IDE for live type errors, or run `npm run typecheck` separately.
    const contexts = await Promise.all(allBuilds.map((b) => esbuild.context(b)))
    await Promise.all(contexts.map((c) => c.watch()))
    console.log('[esbuild] Watching for changes...')
  } else {
    await Promise.all(allBuilds.map((b) => esbuild.build(b)))
    console.log('[esbuild] Build complete')
  }
} catch (err) {
  console.error('[esbuild] Build failed:', err.message)
  process.exit(1)
}
