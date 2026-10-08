import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    preact({
      babel: {
        plugins: ['@emotion/babel-plugin', 'babel-plugin-macros'],
      },
      jsxImportSource: '@emotion/react',
    }),
  ],
  server: {
    host: true,
    port: 3000,
    open: false,
    hmr: true,
  },
})
