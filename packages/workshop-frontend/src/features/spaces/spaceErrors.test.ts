// Vitest runs under node, but the src/ tsconfig only has browser types, hence the suppression.
// @ts-expect-error node builtin without @types/node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  isKeyTakenError,
  isNotAMemberError,
  isSlugInUseError,
  KEY_TAKEN_MESSAGE,
  NOT_A_MEMBER_MESSAGE,
  SLUG_IN_USE_MESSAGE,
} from './spaceErrors'

const kernelSource = (file: string): string =>
  readFileSync(new URL(`../../../../workshop-backend/src/${file}`, import.meta.url), 'utf8')

describe('space refusals', () => {
  // Canary: the API gives these refusals no code, so they are matched by their wording. A reworded
  // refusal would otherwise be shown as an ordinary failure with every other test still passing.
  it('are worded as the kernel words them', () => {
    expect(kernelSource('spaces.ts')).toContain(NOT_A_MEMBER_MESSAGE)
    expect(kernelSource('spaces.ts')).toContain(SLUG_IN_USE_MESSAGE)
    expect(kernelSource('server.ts')).toContain(KEY_TAKEN_MESSAGE)
  })

  it('are told apart from each other and from any other failure', () => {
    const notAMember = new Error(NOT_A_MEMBER_MESSAGE)
    const keyTaken = new Error(KEY_TAKEN_MESSAGE)
    const slugInUse = new Error(SLUG_IN_USE_MESSAGE)

    expect(isNotAMemberError(notAMember)).toBe(true)
    expect(isNotAMemberError(keyTaken)).toBe(false)
    expect(isKeyTakenError(keyTaken)).toBe(true)
    expect(isKeyTakenError(notAMember)).toBe(false)
    expect(isSlugInUseError(slugInUse)).toBe(true)
    expect(isSlugInUseError(keyTaken)).toBe(false)
    for (const other of [new Error('A space must keep at least one admin.'), 'refused', null]) {
      expect(isNotAMemberError(other)).toBe(false)
      expect(isKeyTakenError(other)).toBe(false)
      expect(isSlugInUseError(other)).toBe(false)
    }
  })
})
