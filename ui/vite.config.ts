/// <reference types="vitest" />
import { TanStackRouterVite } from '@tanstack/router-vite-plugin'
import react from '@vitejs/plugin-react'
import path from 'path'
import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [
    react(),
    TanStackRouterVite(),
    nodePolyfills({
      include: ['path', 'stream', 'util'],
      exclude: ['http'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      overrides: {
        fs: 'memfs',
      },
      protocolImports: true,
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    name: 'reti-ui',
    dir: './src',
    watch: false,
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          algorand: ['algosdk', '@algorandfoundation/algokit-utils'],
          icons: ['lucide-react', '@radix-ui/react-icons'],
          tremor: ['@tremor/react'],
          useWallet: ['@txnlab/use-wallet-react'],
        },
      },
    },
  },
})
