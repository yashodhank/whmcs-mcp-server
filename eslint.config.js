import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                project: ['./tsconfig.eslint.json'],
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        files: ['**/*.ts'],
        rules: {
            // TypeScript-specific rules
            '@typescript-eslint/no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
            }],
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-non-null-assertion': 'warn',
            // WHMCS string fields often use `||` so empty string falls through;
            // `??` only replaces null/undefined and would change behaviour.
            '@typescript-eslint/prefer-nullish-coalescing': 'off',
            '@typescript-eslint/prefer-optional-chain': 'error',
            '@typescript-eslint/strict-boolean-expressions': 'off',
            '@typescript-eslint/restrict-template-expressions': ['error', {
                allowNumber: true,
                allowBoolean: true,
            }],
            // MCP SDK still documents server.tool/resource; migration to
            // registerTool/registerResource is tracked separately.
            '@typescript-eslint/no-deprecated': 'off',

            // General rules
            'no-console': ['error', { allow: ['error'] }],
            'no-debugger': 'error',
            'no-duplicate-imports': 'error',
            'prefer-const': 'error',
            'eqeqeq': ['error', 'always'],
        },
    },
    {
        files: ['**/*.test.ts', 'tests/**/*.ts'],
        rules: {
            // Relax rules that are conventional/noise in test code
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/no-empty-function': 'off',
            '@typescript-eslint/require-await': 'off',
            '@typescript-eslint/no-unnecessary-condition': 'off',
            '@typescript-eslint/no-unsafe-return': 'off',
            '@typescript-eslint/no-confusing-void-expression': 'off',
            '@typescript-eslint/dot-notation': 'off',
            '@typescript-eslint/no-base-to-string': 'off',
            '@typescript-eslint/non-nullable-type-assertion-style': 'off',
            // Vitest setup/integration harness prints to stderr/stdout by design.
            'no-console': 'off',
            'no-control-regex': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
        },
    },
    {
        ignores: [
            'dist/',
            'node_modules/',
            'coverage/',
            '*.config.js',
            '*.config.ts',
        ],
    }
);
