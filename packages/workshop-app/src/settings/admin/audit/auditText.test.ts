import { describe, expect, it } from 'vitest'
import { accessHelp, changeName, excerptLabel, layOut, mayOverflow } from './auditText'

describe('changeName', () => {
  it('is the setting, with the entry changed where it has one', () => {
    expect(changeName({ setting: 'siteName' })).toBe('siteName')
    expect(changeName({ setting: 'formats', key: 'bp-doc' })).toBe('formats · bp-doc')
  })

  it('is a change of order for a list of entries changed with no key, and for an order itself', () => {
    expect(changeName({ setting: 'formats' })).toBe('Order of formats')
    expect(changeName({ setting: 'addedModels' })).toBe('Order of added models')
    expect(changeName({ setting: 'providerOrder' })).toBe('Order of providers')
    expect(changeName({ setting: 'modelOrder', key: 'openai' })).toBe('Order of models · openai')
  })
})

describe('excerptLabel', () => {
  it('counts characters from one, and says where a side has no length', () => {
    expect(excerptLabel({ offset: 1199, beforeLength: 4000, afterLength: 4120 }))
      .toBe('Excerpt from character 1,200 · 4,000 → 4,120 characters')
    expect(excerptLabel({ offset: 0, afterLength: 12 })).toBe('Excerpt from character 1 · — → 12 characters')
  })
})

describe('layOut', () => {
  it('lays out compact JSON one field to a line', () => {
    expect(layOut('{"a":1,"b":[2]}')).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}')
  })

  it('leaves text, JSON as an admin spaced it, and values that are not objects as they are', () => {
    expect(layOut('Hello')).toBe('Hello')
    expect(layOut('{ "a": 1 }')).toBe('{ "a": 1 }')
    expect(layOut('42')).toBe('42')
    expect(layOut('null')).toBe('null')
  })
})

describe('mayOverflow', () => {
  it('is for a value long in characters or in lines', () => {
    expect(mayOverflow('short')).toBe(false)
    expect(mayOverflow('x'.repeat(481))).toBe(true)
    expect(mayOverflow('1\n2\n3\n4\n5\n6\n7')).toBe(true)
  })
})

describe('accessHelp', () => {
  it('says only what access is while nothing limits it', () => {
    expect(accessHelp({ chosen: 'metadata', effective: 'metadata', max: 'metadata' })).toHaveLength(1)
  })

  it('says the maximum allows none, and how to make the level it holds down the admins’ own', () => {
    const help = accessHelp({ chosen: 'metadata', effective: 'off', max: 'off' })
    expect(help).toHaveLength(3)
    expect(help[1]).toContain('ADMIN_WORKSPACE_ACCESS_MAX')
    expect(help[2]).toBe('The level set here is Metadata, which that maximum limits to Off. Set Off here, so that a higher maximum does not raise it.')
  })
})
