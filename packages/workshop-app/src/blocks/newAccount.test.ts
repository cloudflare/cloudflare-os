import { describe, expect, it } from 'vitest'
import { canCreateAccount, newAccountProblems } from './newAccount'

describe('newAccountProblems', () => {
  it('says nothing of a field that is empty, which is not wrong yet', () => {
    expect(newAccountProblems({ username: '', password: '', confirm: '' })).toEqual({ username: undefined, password: undefined, confirm: undefined })
  })

  it('says what is wrong with each field', () => {
    expect(newAccountProblems({ username: 'ada lovelace', password: 'short', confirm: 'other' })).toEqual({
      username: 'Letters, numbers, underscores, and hyphens only',
      password: 'Must be at least 8 characters',
      confirm: 'Passwords do not match',
    })
  })
})

describe('canCreateAccount', () => {
  it('asks for every field, filled in and right', () => {
    expect(canCreateAccount({ username: 'ada_l-1', password: 'analytical', confirm: 'analytical' })).toBe(true)
    expect(canCreateAccount({ username: 'ada', password: 'analytical', confirm: '' })).toBe(false)
    expect(canCreateAccount({ username: 'ada!', password: 'analytical', confirm: 'analytical' })).toBe(false)
    expect(canCreateAccount({ username: 'ada', password: 'analytic', confirm: 'analytica' })).toBe(false)
  })
})
