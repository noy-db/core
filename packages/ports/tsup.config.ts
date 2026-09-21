import { defineConfig } from 'tsup'

// Six entries, one per hub port. `splitting: false` on purpose: every kit
// shipped that way, and it is what makes each subpath a self-contained entry —
// nothing here can degenerate into a hash-named shared chunk (core#1458's
// shape). `__tests__/subpaths.test.ts` resolves every subpath through the
// package's own `exports` map and calls the function it exports, with a
// control, so a dropped or mis-wired entry fails loudly rather than shipping.
export default defineConfig({
  entry: {
    'to/index': 'src/to/index.ts',
    'as/index': 'src/as/index.ts',
    'at/index': 'src/at/index.ts',
    'on/index': 'src/on/index.ts',
    'by/index': 'src/by/index.ts',
    'capsule/index': 'src/capsule/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'es2022',
})
