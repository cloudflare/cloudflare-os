import { describe, expect, it } from 'vitest'
import { MAX_APP_PROMPT_LENGTH, normalizeAppPrompt, parseAppWorkspaceTarget } from './appNavigation'

const WORKSPACE_ID = 'a'.repeat(64)

describe('parseAppWorkspaceTarget', () => {
  it('takes a workspace’s id, and a gadget in it', () => {
    expect(parseAppWorkspaceTarget(WORKSPACE_ID, undefined)).toEqual({ workspaceId: WORKSPACE_ID })
    expect(parseAppWorkspaceTarget(WORKSPACE_ID, 0)).toEqual({ workspaceId: WORKSPACE_ID, gadgetId: 0 })
  })

  it.each([
    ['', undefined],
    ['../admin', undefined],
    [WORKSPACE_ID.toUpperCase(), undefined],
    [`${WORKSPACE_ID}a`, undefined],
    [WORKSPACE_ID, -1],
    [WORKSPACE_ID, 1.5],
    [WORKSPACE_ID, 9_007_199_254_740_992],
    [WORKSPACE_ID, '1'],
  ])('refuses (%s, %s)', (workspaceId, gadgetId) => {
    expect(() => parseAppWorkspaceTarget(workspaceId, gadgetId)).toThrow('Invalid gatekeeper app workspace target')
  })
})

describe('normalizeAppPrompt', () => {
  it('trims a prompt', () => {
    expect(normalizeAppPrompt('  Set up a daily brief.  ')).toBe('Set up a daily brief.')
  })

  it('refuses one that is empty, too long or not text', () => {
    expect(() => normalizeAppPrompt('   ')).toThrow('cannot be empty')
    expect(() => normalizeAppPrompt('x'.repeat(MAX_APP_PROMPT_LENGTH + 1))).toThrow('too long')
    expect(() => normalizeAppPrompt(42)).toThrow('must be text')
  })
})
