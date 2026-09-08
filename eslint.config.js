import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, {
  ignores: ['node_modules', 'dist', 'out.png'],
}, {
  files: ['src/public/**/*.js'],
  languageOptions: {
    globals: {
      document: 'readonly',
      fetch: 'readonly',
      FormData: 'readonly',
      navigator: 'readonly',
      window: 'readonly',
      localStorage: 'readonly',
      URL: 'readonly',
      URLSearchParams: 'readonly',
    },
  },
})
