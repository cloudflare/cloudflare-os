import { describe, expect, it } from 'vitest'
import { workspaceInitials } from './workspaceInitials'

describe('workspaceInitials', () => {
  it('takes the first two letters of the title, as the design does', () => {
    expect(workspaceInitials('Engineering')).toBe('EN')
    expect(workspaceInitials('Workspace 1')).toBe('WO')
  })

  it('skips characters that are not letters or digits', () => {
    expect(workspaceInitials('🚀 launch')).toBe('LA')
    expect(workspaceInitials('  q4 plans')).toBe('Q4')
  })

  it('falls back to a neutral mark when there is nothing to show', () => {
    expect(workspaceInitials('🎉')).toBe('··')
  })
})
