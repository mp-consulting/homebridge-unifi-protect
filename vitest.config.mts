import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const uiDir = fileURLToPath(new URL('./homebridge-ui/', import.meta.url));

export default defineConfig({
  plugins: [
    {
      // The custom UI server imports the compiled plugin from dist/. Point those imports at the TypeScript sources so tests always exercise the current code
      // without requiring a build first. We only rewrite imports made from within homebridge-ui/ so that dependencies are never affected.
      name: 'homebridge-ui-dist-to-src',
      enforce: 'pre',
      resolveId(source: string, importer?: string): string | null {

        const match = /^\.\.\/dist\/(.*)\.js$/.exec(source);

        if(!match?.[1] || !importer || !path.resolve(importer).startsWith(uiDir)) {

          return null;
        }

        return fileURLToPath(new URL('./src/' + match[1] + '.ts', import.meta.url));
      },
    },
  ],
  test: {
    environment: 'node',
    globals: true,
    include: [
      'src/**/*.{test,spec}.ts',
      'test/**/*.{test,spec}.ts',
    ],
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'homebridge-ui/*.js'],
      exclude: ['src/**/*.{test,spec}.ts', 'src/**/__tests__/**'],

      // Fail the run if coverage regresses. Ratchet these upward as coverage improves.
      thresholds: {
        branches: 43,
        functions: 51,
        lines: 53,
        statements: 52,
      },
    },
  },
  oxc: {
    target: 'es2022',
  },
});
