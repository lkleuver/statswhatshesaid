import { defineConfig } from 'tsup'

// The shebang for the CLI lives at the top of `src/cli.ts` (esbuild
// preserves shebangs on entry files). This keeps `dist/index.js` clean —
// only `dist/cli.js` is executable.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  clean: true,
  sourcemap: true,
  target: 'node20',
  external: ['better-sqlite3'],
})
