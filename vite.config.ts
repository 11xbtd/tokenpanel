import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:5188',
    },
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1600,
  },
})
