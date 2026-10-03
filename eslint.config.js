import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Ignores
  {
    ignores: ['dist/**', 'node_modules/**', 'homebridge-ui/public/lib/**', 'tmp/**'],
  },
  // Base recommended configs
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  // Language options
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
  },
  // Type-aware linting for the plugin and test sources. The project service resolves src/** through tsconfig.json and test/** through test/tsconfig.json
  // (which extends tsconfig.test.json). The homebridge-ui JavaScript remains untyped.
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
    },
  },
  // Shared library files are kept byte-identical with a sibling repository, so type-aware findings in them are addressed upstream rather than here.
  {
    files: ['src/lib/{featureoptions,mqtt-connection,mqttclient,request,service,ui-server,util,websocket}.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
  // Core rules
  {
    rules: {
      // Style
      'quotes': ['error', 'single', { avoidEscape: true }],
      'indent': ['error', 2, { SwitchCase: 1 }],
      'linebreak-style': ['error', 'unix'],
      'semi': ['error', 'always'],
      'comma-dangle': ['error', 'always-multiline'],
      'object-curly-spacing': ['error', 'always'],
      'max-len': ['error', { code: 160, ignoreUrls: true, ignoreStrings: true }],

      // Best practices
      'dot-notation': 'error',
      'eqeqeq': ['error', 'smart'],
      'curly': ['error', 'all'],
      'brace-style': ['error', '1tbs'],
      'prefer-arrow-callback': 'error',
      'prefer-const': 'error',
      'no-var': 'error',

      // TypeScript
      'no-use-before-define': 'off',
      '@typescript-eslint/no-use-before-define': ['error', { classes: false, enums: false, functions: false }],
      '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none', argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    },
  },
  // Test files — relaxed rules
  {
    files: ['src/**/*.{test,spec}.ts', 'test/**/*.{test,spec}.ts', 'src/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-use-before-define': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // Node.js development scripts
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        setInterval: 'readonly',
      },
    },
  },
  // homebridge-ui browser globals
  {
    files: ['homebridge-ui/public/**/*.mjs', 'homebridge-ui/public/**/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        homebridge: 'readonly',
        bootstrap: 'readonly',
        MpKit: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        container: 'readonly',
        fetch: 'readonly',
        getComputedStyle: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-use-before-define': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  // homebridge-ui server globals
  {
    files: ['homebridge-ui/server.js', 'homebridge-ui/*.js'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
      },
    },
  },
);
