import { describe, expect, it } from 'vitest'
import { workspaceLabel } from './workspaceLabel'

describe('workspaceLabel', () => {
  it('uses the initials of the first two words', () => {
    expect(workspaceLabel('Untitled Workspace')).toBe('UW')
    expect(workspaceLabel('Refactor conditional rendering logic')).toBe('RC')
  })

  it('uses the first two letters of a single word', () => {
    expect(workspaceLabel('dashboard')).toBe('DA')
    expect(workspaceLabel('X')).toBe('X')
  })

  it('ignores surrounding and repeated whitespace', () => {
    expect(workspaceLabel('  jira   stats  ')).toBe('JS')
  })

  it('is empty for an empty title rather than throwing', () => {
    expect(workspaceLabel('')).toBe('')
    expect(workspaceLabel('   ')).toBe('')
  })
})
