import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve('src/shared')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      // Five entries, one build, because all five are node/cjs — but only `index`
      // may import `electron`:
      //   cli       a plain Node script run from a compositor bind.
      //   host      the utilityProcess entry. It has `process.parentPort`, not
      //             `electron`; importing the latter would give it a path string.
      //   worker    the `worker_threads` entry the host spawns per extension.
      //   lumanin   the plugin API module — everything `import … from 'lumanin'`
      //             can reach, loaded by the worker's resolution hook rather
      //             than imported by anything here. It is listed so rollup
      //             emits it; nothing in the app requires it directly. Its API
      //             shape follows the pinned spec, but the
      //             module a plugin names is only ever ours.
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // The two applications behind the dispatcher. Explicit inputs so they
          // emit at the out/main root rather than under chunks/ — both resolve
          // sibling files (`host.js`, `../renderer`, `../preload`) against
          // their own `__dirname`, which must therefore be out/main.
          daemon: resolve('src/main/daemon.ts'),
          'settings-app': resolve('src/main/settings-app.ts'),
          cli: resolve('src/cli/index.ts'),
          host: resolve('src/host/index.ts'),
          worker: resolve('src/host/worker.ts'),
          lumanin: resolve('src/api-shim/lumanin.ts'),
          //   plugin-build  the extension builder, on its own so
          //             `scripts/build-plugins.mjs` can call the *same*
          //             `buildExtension` a user's `plugin-install` calls rather
          //             than a second, simpler copy of it that would drift.
          'plugin-build': resolve('src/main/extensions/build.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@shared': shared,
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    build: {
      // electron-vite leaves this off by default; the renderer bundle is parsed
      // once at daemon start, but shipping ~560 kB of unminified React is still
      // startup cost paid for nothing.
      minify: true,
      rollupOptions: {
        // Two pages, one bundle graph: the panel and the settings window share
        // React, the theme runtime and the styles; Vite splits the common
        // chunks automatically.
        input: {
          index: resolve('src/renderer/index.html'),
          settings: resolve('src/renderer/settings.html')
        }
      }
    }
  }
})
