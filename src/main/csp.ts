import { session } from 'electron'
import { ICON_SCHEME } from '../shared/identity'

/**
 * Content Security Policy, per SECURITY.md §Renderer. Applied as a response
 * header rather than a `<meta>` tag so it also covers the dev server, and so a
 * future extension-supplied `Detail` view cannot relax it from inside the page.
 *
 * Shared by the daemon and the settings app: two applications, one renderer
 * contract.
 */
export function applyCsp(devServerUrl: string | null): void {
  const scriptSrc = devServerUrl === null ? "'self'" : `'self' 'unsafe-inline' ${devServerUrl}`
  const connectSrc =
    devServerUrl === null ? "'self'" : `'self' ${devServerUrl} ${devServerUrl.replace(/^http/, 'ws')}`

  const policy = [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    // Inline styles are required: the theme runtime writes custom properties
    // onto `:root`. Nothing else is permitted.
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    // `data:` is size-capped by Chromium; remote images are allowed only over TLS.
    // `file:` is deliberately gone: icons come through our own scheme, which
    // serves only what main resolved, so the renderer has no reason to reach the
    // filesystem directly and no longer can.
    `img-src 'self' data: ${ICON_SCHEME}: https:`,
    `connect-src ${connectSrc}`,
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'"
  ].join('; ')

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy]
      }
    })
  })
}
