import { describe, expect, it } from 'vitest'
import { markdownUrl, webUrl } from './webUrl'

describe('webUrl', () => {
  it('is a web address, and nothing else: no script, no relative or malformed address', () => {
    expect(webUrl('https://example.com/a?b')).toBe('https://example.com/a?b')
    expect(webUrl('http://example.com')).toBe('http://example.com')
    for (const url of ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', '/inside', 'not a url', '', undefined]) {
      expect(webUrl(url)).toBeUndefined()
    }
  })

  it('takes other schemes only when asked', () => {
    expect(webUrl('mailto:ada@example.com')).toBeUndefined()
    expect(webUrl('mailto:ada@example.com', ['mailto:'])).toBe('mailto:ada@example.com')
  })
})

describe('markdownUrl', () => {
  it('links web and mail addresses only', () => {
    expect(markdownUrl('https://example.com', 'href')).toBe('https://example.com')
    expect(markdownUrl('mailto:ada@example.com', 'href')).toBe('mailto:ada@example.com')
    expect(markdownUrl('javascript:alert(1)', 'href')).toBeUndefined()
    expect(markdownUrl('data:text/html,hi', 'href')).toBeUndefined()
    expect(markdownUrl('blob:https://app/1', 'href')).toBeUndefined()
  })

  it('shows an image only from what fetches nothing, and leaves one from elsewhere to be linked', () => {
    expect(markdownUrl('data:image/png;base64,AAAA', 'src')).toBe('data:image/png;base64,AAAA')
    expect(markdownUrl('blob:https://app/1', 'src')).toBe('blob:https://app/1')
    expect(markdownUrl('https://tracker.example/p.gif?secret', 'src')).toBe('https://tracker.example/p.gif?secret')
    expect(markdownUrl('javascript:alert(1)', 'src')).toBeUndefined()
  })
})
