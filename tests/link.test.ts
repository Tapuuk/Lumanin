import { describe, expect, it } from 'vitest'
import { linkTarget } from '../src/shared/link'

describe('linkTarget', () => {
  it('draws a control for http(s), whatever the case', () => {
    for (const href of ['https://x', 'http://x', 'HTTPS://X']) {
      expect(linkTarget(href)).toEqual({ kind: 'web', url: href })
    }
  })

  it('draws text for every scheme the panel cannot open', () => {
    for (const href of ['mailto:a@b', 'file:///etc/hosts', 'vscode://x', 'lumanin://x', 'javascript:alert(1)']) {
      expect(linkTarget(href)).toEqual({ kind: 'text' })
    }
  })

  it('draws text for what is not a URL at all', () => {
    expect(linkTarget('./relative.md')).toEqual({ kind: 'text' })
    expect(linkTarget('')).toEqual({ kind: 'text' })
  })
})
