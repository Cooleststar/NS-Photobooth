import { defineConfig } from 'vite'

export default defineConfig({
  esbuild: {
    jsxImportSource: 'preact',
    jsx: 'automatic',
  },
  server: {
    host: true,
    port: 5173,
  },
})
