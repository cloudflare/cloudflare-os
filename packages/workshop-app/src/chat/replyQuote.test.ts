import { describe, expect, it } from 'vitest'
import { quoteOf, splitQuote, withQuote } from './replyQuote'

describe('quoteOf', () => {
  it('reads a Markdown message as one plain line', () => {
    const message = '## Done\n\nThe chart now covers **12 weeks**:\n\n- the window is a constant in `chart.tsx`\n1. see [the docs](https://example.com/docs)\n\n> as asked'
    expect(quoteOf(message)).toBe('Done The chart now covers 12 weeks: the window is a constant in chart.tsx see the docs as asked')
  })

  it('leaves marks that are part of the words', () => {
    expect(quoteOf('set max_results to 2 * limit - 1')).toBe('set max_results to 2 * limit - 1')
  })

  it('cuts a long message off, between characters', () => {
    const quote = quoteOf('😀'.repeat(300))
    expect([...quote]).toHaveLength(241)
    expect(quote.endsWith('😀…')).toBe(true)
  })
})

describe('splitQuote', () => {
  it('takes apart what withQuote put together', () => {
    const message = withQuote('The chart now covers 12 weeks', 'Make it 24\n\n> and keep this')
    const { quote, body, offset } = splitQuote(message)
    expect(quote).toBe('The chart now covers 12 weeks')
    expect(body).toBe('Make it 24\n\n> and keep this')
    expect(message.slice(offset)).toBe(body)
  })

  it('reads a quote of several lines as one', () => {
    expect(splitQuote('> one\n>two\n>\n> three\n\nok')).toMatchObject({ quote: 'one two three', body: 'ok' })
  })

  it.each([
    ['no quote', 'Make it dark'],
    ['only a quote', '> The chart now covers 12 weeks\n\n'],
    ['a quote with nothing in it', '>\n\nok'],
    ['a quote the reply runs on from', '> 5 is more\nthan 4'],
    ['a quote further in', 'As you said:\n\n> twelve weeks\n\nfine'],
  ])('leaves a message with %s whole', (_, message) => {
    expect(splitQuote(message)).toEqual({ body: message, offset: 0 })
  })
})
