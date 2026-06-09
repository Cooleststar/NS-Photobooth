import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

import { basename } from 'path'
import { readFileSync } from 'fs'

// https://github.com/google/mediapipe/issues/2883
function mediapipeWorkaround() {
  return {
    name: 'mediapipe_workaround',
    load: (id: string) => {
      if (basename(id) === 'drawing_utils.js') {
        let code = readFileSync(id, 'utf-8')
        code += 'exports.drawLandmarks = drawLandmarks;'
        return { code }
      } else {
        return null
      }
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
  const isProd = mode == 'production'
  return {
    plugins: [
      preact({
        babel: {
          plugins: ['@emotion/babel-plugin', 'babel-plugin-macros'],
        },
        jsxImportSource: '@emotion/react',
      }),
      mediapipeWorkaround(),
    ],
    resolve: {
      alias: {
        // https://github.com/vitejs/vite/issues/1979
        'socket.io-client': 'socket.io-client/dist/socket.io.js',
      },
    },
    server: {
      host: true,
      port: 3000,
      open: false,
      hmr: true,
    },
    optimizeDeps: {
      exclude: ['@jsquash/avif'],
    },
  }
})
