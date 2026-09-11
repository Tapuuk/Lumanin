import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Platform probes and XDG paths are read from the environment; tests mutate
    // process.env, so they must not share a process.
    isolate: true
  }
})
