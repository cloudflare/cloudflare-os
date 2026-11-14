import { describe, expect, it } from 'vitest'
import { isGranted, patternsToConnect, patternsToGrant } from './resourceGrants'

const grantable = ['https://mail/*', 'https://docs/*', 'https://drive/*']

describe('isGranted', () => {
  it('takes an account that does not say as having everything', () => {
    expect(isGranted(undefined, 'https://mail/*')).toBe(true)
    expect(isGranted([], 'https://mail/*')).toBe(false)
    expect(isGranted(['https://mail/*'], 'https://mail/*')).toBe(true)
  })
})

describe('patternsToConnect', () => {
  it('asks for everything when all are on', () => {
    expect(patternsToConnect(grantable, new Set(grantable))).toBeUndefined()
  })

  it('asks for those on, in the service’s order', () => {
    expect(patternsToConnect(grantable, new Set(['https://drive/*', 'https://mail/*']))).toEqual(['https://mail/*', 'https://drive/*'])
  })

  it('asks for none when none are on', () => {
    expect(patternsToConnect(grantable, new Set())).toEqual([])
  })
})

describe('patternsToGrant', () => {
  it('is those on that are not granted yet', () => {
    expect(patternsToGrant(grantable, new Set(grantable), ['https://docs/*'])).toEqual(['https://mail/*', 'https://drive/*'])
  })

  it('is nothing for an account that has everything', () => {
    expect(patternsToGrant(grantable, new Set(grantable), undefined)).toEqual([])
  })
})
