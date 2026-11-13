import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from './Markdown'

const html = (markdown: string) => renderToStaticMarkup(createElement(Markdown, null, markdown))

describe('Markdown', () => {
  it('renders no raw HTML', () => {
    expect(html('Hi <img src="https://tracker.example/p.gif"> <script>alert(1)</script>')).not.toMatch(/<img|<script/)
  })

  it('drops links that are not to the web or a mailbox, keeping their text', () => {
    const out = html('[ok](https://example.com) [mail](mailto:ada@example.com) [bad](javascript:alert(1))')
    expect(out).toContain('href="https://example.com"')
    expect(out).toContain('href="mailto:ada@example.com"')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('<span>bad</span>')
  })

  it('links an image from elsewhere instead of loading it, and shows one carried in the text', () => {
    const remote = html('![the chart](https://tracker.example/p.gif?q=secret)')
    expect(remote).not.toContain('<img')
    expect(remote).toContain('<a href="https://tracker.example/p.gif?q=secret" target="_blank" rel="noreferrer noopener">the chart</a>')

    expect(html('![dot](data:image/png;base64,AAAA)')).toContain('<img src="data:image/png;base64,AAAA" alt="dot"/>')
    expect(html('![x](javascript:alert(1))')).not.toMatch(/<img|<a|javascript:/)
  })
})
