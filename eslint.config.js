import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
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
            '@typescript-eslint/prefer-nullish-coalescing': 'error',
            '@typescript-eslint/prefer-optional-chain': 'error',
            '@typescript-eslint/strict-boolean-expressions': 'off',
            '@typescript-eslint/restrict-template-expressions': ['error', {
                allowNumber: true,
                allowBoolean: true,
            }],

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
            // Relax some rules for tests
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
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
