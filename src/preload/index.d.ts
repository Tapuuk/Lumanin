import type { LumaninBridge } from '../shared/ipc'

declare global {
  interface Window {
    readonly lumanin: LumaninBridge
  }
}

export {}
