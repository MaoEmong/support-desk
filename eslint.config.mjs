import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config({ ignores: ['**/node_modules/**', '**/.next/**', '**/next-env.d.ts', '**/dist/**', 'docs/verification/stage2/e2e/**/html/**', '.pixel-office/**', '.codex/**'] }, js.configs.recommended, ...tseslint.configs.recommended, { rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } });
