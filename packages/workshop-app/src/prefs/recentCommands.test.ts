import { describe, expect, it } from 'vitest'
import { byRecentUse } from './recentCommands'

describe('byRecentUse', () => {
  it('puts those chosen last first, latest first, and keeps the rest in their order', () => {
    const commands = ['alpha', 'brief', 'compact', 'digest'].map((key) => ({ key }))
    expect(byRecentUse(commands, ['digest', 'gone', 'brief']).map(({ key }) => key)).toEqual(['digest', 'brief', 'alpha', 'compact'])
  })
})
