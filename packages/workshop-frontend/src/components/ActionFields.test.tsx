// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { afterEach, describe, expect, it } from 'vitest'
import type { ActionField } from '@gadgets/workshop-shared/gatekeeper'
import { makeTestRoot } from '../action-test-harness'
import { ActionFields } from './ActionFields'

const view = makeTestRoot()

afterEach(() => view.cleanup())

async function render(fields: ActionField[]) {
  await view.render(<ActionFields fields={fields} />)
  return document.body.querySelector('dl')!
}

describe('ActionFields', () => {
  it('shows values that look like Markdown or HTML as literal text', async () => {
    const hostile = 'LGTM ```but``` <script>alert(1)</script> ![x](https://evil.example/x.png)'
    const list = await render([
      { label: 'Title', kind: 'inline', value: hostile },
      { label: 'Body', kind: 'text', value: `# Heading\n\n**bold** ${hostile}`, syntax: 'markdown' },
      { label: 'Labels', kind: 'list', items: [hostile] },
    ])

    expect(list.querySelector('script, img, a, h1, strong')).toBeNull()
    const [title, body, labels] = [...list.querySelectorAll('dd')]
    expect(title!.querySelector('code')!.textContent).toBe(hostile)
    expect(body!.querySelector('pre')!.textContent).toBe(`# Heading\n\n**bold** ${hostile}`)
    expect(body!.textContent).toContain('Markdown')
    expect(labels!.querySelector('code')!.textContent).toBe(hostile)
  })

  it('names the syntax of JSON and notes CRLF line breaks', async () => {
    const list = await render([
      { label: 'Arguments', kind: 'json', value: '{\n  "a": 1\n}' },
      { label: 'Plain text', kind: 'text', value: 'one\r\ntwo' },
      { label: 'Note', kind: 'text', value: 'one\ntwo' },
    ])

    const [args, crlf, lf] = [...list.querySelectorAll('dd')]
    expect(args!.textContent).toContain('JSON')
    expect(crlf!.querySelector('pre')!.textContent).toBe('one\r\ntwo')
    expect(crlf!.textContent).toContain('CRLF line breaks')
    expect(lf!.textContent).not.toContain('CRLF')
  })

  it('shows a file card, and says an agent file\'s contents are not shown', async () => {
    const file = { name: 'report.pdf', mediaType: 'application/pdf', size: 2048, sha256: 'ab'.repeat(32) }
    const list = await render([
      { label: 'Attachment 1', kind: 'file', ...file, origin: 'provider' },
      { label: 'File', kind: 'file', ...file, origin: 'agent' },
    ])

    const [provider, agent] = [...list.querySelectorAll('dd')]
    for (const card of [provider!, agent!]) {
      expect(card.textContent).toContain('report.pdf')
      expect(card.textContent).toContain('application/pdf')
      expect(card.textContent).toContain('2048 bytes')
      expect(card.textContent).toContain(`SHA-256 ${'ab'.repeat(32)}`)
    }
    expect(provider!.textContent).not.toContain('Contents not shown')
    expect(agent!.textContent).toContain('Contents not shown')
  })

  it('says how much of a truncated field is shown, and names an omitted one', async () => {
    const list = await render([
      { label: 'Body', kind: 'text', value: 'abc', truncated: { shownBytes: 3, totalBytes: 9000 } },
      { label: 'Comment', kind: 'inline', value: '', truncated: { shownBytes: 0, totalBytes: 12 } },
    ])

    const [body, comment] = [...list.querySelectorAll('dd')]
    expect(body!.textContent).toContain('Showing 3 of 9000 bytes')
    expect(comment!.textContent).toBe('Omitted: description limit reached')
    expect([...list.querySelectorAll('dt')].map(dt => dt.textContent)).toEqual(['Body', 'Comment'])
  })

  it('names empty values rather than showing nothing', async () => {
    const list = await render([
      { label: 'Title', kind: 'inline', value: '' },
      { label: 'Labels', kind: 'list', items: [] },
    ])

    expect([...list.querySelectorAll('dd')].map(dd => dd.textContent)).toEqual(['(empty)', '(none)'])
  })
})
