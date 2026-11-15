import { describe, expect, it } from 'vitest'
import { rehypePageBlocks } from './usePages'

describe('rehypePageBlocks', () => {
  it('wraps each top-level element, and leaves the text between them', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'element', tagName: 'h1', children: [{ type: 'text', value: 'Title' }] },
        { type: 'text', value: '\n' },
        { type: 'element', tagName: 'ul', children: [] },
      ],
    }
    rehypePageBlocks()(tree)
    expect(tree.children.map((child) => [child.type, 'tagName' in child ? child.tagName : undefined])).toEqual([
      ['element', 'div'], ['text', undefined], ['element', 'div'],
    ])
    expect(tree.children[0]).toMatchObject({ properties: { dataPageBlock: '' }, children: [{ tagName: 'h1' }] })
  })
})
