import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', next: 'src/next.ts' },
  format: ['esm'],
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  external: ['next', 'next/server', 'next/server.js'],
});
