#!/usr/bin/env node
// Entry shim for the `lumanin` CLI. The real implementation is built to
// out/main/cli.js by electron-vite; this file exists so the bin path is stable
// whether the app is run from a checkout or from a package.
'use strict'

const { existsSync } = require('node:fs')
const { join } = require('node:path')

const cli = join(__dirname, '..', 'out', 'main', 'cli.js')

if (!existsSync(cli)) {
  process.stderr.write('lumanin: not built yet — run `npm run build`\n')
  process.exit(1)
}

require(cli)
