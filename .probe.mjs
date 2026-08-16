import { _electron as electron } from '@playwright/test'
import { execSync } from 'node:child_process'
const S = process.argv[2]
const env = { ...process.env, WAYLAND_DISPLAY: process.env.XDG_RUNTIME_DIR + '/' + process.env.WAYLAND_DISPLAY, XDG_RUNTIME_DIR: S+'/probe2/run', XDG_DATA_HOME: S+'/probe2/data', XDG_STATE_HOME: S+'/probe2/state-real' }
const app = await electron.launch({ args: ['/home/tapkich/Lumanin'], env })
const page = await app.firstWindow()
await page.waitForTimeout(2500)
const hy = () => execSync(`hyprctl clients -j | jq -c '[.[] | select(.class=="lumanin") | .size]'`).toString().trim()
const sleep = ms => new Promise(r => setTimeout(r, ms))
await app.evaluate(({ BrowserWindow }) => { const w = new BrowserWindow({ width: 800, height: 300, resizable: true, frame: false, show: false, transparent: true, backgroundColor: '#00000000' }); w.loadURL('data:text/html,<body style="background:red;margin:0"><div style="border:4px solid lime;height:100vh;box-sizing:border-box"></div></body>'); globalThis.__w = w })
await sleep(800)
await app.evaluate(() => globalThis.__w.show()); await sleep(1200)
console.log('RESULT created800', hy(), await app.evaluate(() => globalThis.__w.getSize()))
execSync(`grim ${S}/rz1.png`)
await app.evaluate(() => { globalThis.__w.hide(); globalThis.__w.setSize(600, 200) }); await sleep(600)
await app.evaluate(() => globalThis.__w.show()); await sleep(1200)
console.log('RESULT hidden-setSize600', hy(), await app.evaluate(() => globalThis.__w.getSize()))
await app.evaluate(() => { globalThis.__w.hide(); globalThis.__w.setBounds({ x: 0, y: 0, width: 500, height: 150 }) }); await sleep(600)
await app.evaluate(() => globalThis.__w.show()); await sleep(1200)
console.log('RESULT hidden-setBounds500', hy(), await app.evaluate(() => globalThis.__w.getSize()))
await app.evaluate(() => { globalThis.__w.setSize(700, 250) }); await sleep(1200)
console.log('RESULT visible-setSize700', hy(), await app.evaluate(() => globalThis.__w.getSize()))
await app.close().catch(() => {}); process.exit(0)
