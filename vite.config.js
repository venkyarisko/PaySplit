import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/pakasir-api': {
        target: 'https://app.pakasir.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/pakasir-api/, '')
      }
    }
  }
})
