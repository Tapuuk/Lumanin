import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  EVENT_CHANNEL,
  INVOKE_CHANNEL,
  type EventEnvelope,
  type EventMap,
  type EventName,
  type InvokeMap,
  type InvokeMethod,
  type LumaninBridge
} from '../shared/ipc'

/**
 * The preload bridge (`window.lumanin`).
 *
 * This runs in a sandboxed, context-isolated world. It exposes exactly two
 * operations and no Electron or Node object ever crosses into page scope —
 * `ipcRenderer` itself must not be exposed, or the allow-list in main becomes
 * decorative.
 *
 * This file must stay CommonJS-compatible: sandboxed preloads cannot be ES
 * modules, which is why the package is not `"type": "module"`.
 */

const bridge: LumaninBridge = {
  invoke<M extends InvokeMethod>(method: M, params?: InvokeMap[M]['params']): Promise<InvokeMap[M]['result']> {
    return ipcRenderer.invoke(INVOKE_CHANNEL, method, params) as Promise<InvokeMap[M]['result']>
  },

  on<E extends EventName>(event: E, listener: (payload: EventMap[E]) => void): () => void {
    const wrapped = (_e: IpcRendererEvent, envelope: EventEnvelope): void => {
      if (envelope.event !== event) return
      listener(envelope.payload as EventMap[E])
    }
    ipcRenderer.on(EVENT_CHANNEL, wrapped)
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNEL, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('lumanin', bridge)
