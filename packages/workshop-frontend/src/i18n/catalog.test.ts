import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import en from './en'
import ko from './ko'
import type { MessageTree } from './types'

const flatten = (tree: MessageTree, prefix = ''): Record<string, string> =>
  Object.fromEntries(Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return typeof value === 'string' ? [[path, value]] : Object.entries(flatten(value, path))
  }))

const english = flatten(en)
const korean = flatten(ko)
const variables = (message: string) => [...message.matchAll(/\{(\w+)\}/g)]
  .map(match => match[1]).toSorted()

describe('translation catalogs', () => {
  it('provides Korean entries for every English key, with no orphan keys', () => {
    expect(Object.keys(korean).toSorted()).toEqual(Object.keys(english).toSorted())
  })

  it('preserves interpolation variables in every Korean message', () => {
    const mismatches = Object.keys(english).filter(key =>
      JSON.stringify(variables(english[key])) !== JSON.stringify(variables(korean[key] ?? '')),
    )
    expect(mismatches).toEqual([])
  })

  it('defines every statically referenced UI message', () => {
    const src = fileURLToPath(new URL('../', import.meta.url))
    const missing = new Set<string>()
    for (const file of readdirSync(src, { recursive: true }) as string[]) {
      if (!/\.tsx?$/.test(file) || file.startsWith('i18n/')) continue
      const source = readFileSync(`${src}/${file}`, 'utf8')
      for (const match of source.matchAll(/\bt\(['"]([^'"]+)['"]/g)) {
        if (!(match[1] in english)) missing.add(match[1])
      }
    }
    expect([...missing].toSorted()).toEqual([])
  })
})
