// Vitest runs under node, but the src/ tsconfig only has browser types, hence the suppression.
// @ts-expect-error node builtin without @types/node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  INVALID_SPACE_ID_MESSAGE,
  isNotAMemberError,
  NOT_A_MEMBER_MESSAGE,
} from './spaceErrors'

const kernelSource = (file: string): string =>
  readFileSync(new URL(`../../../../workshop-backend/src/${file}`, import.meta.url), 'utf8')

describe('space refusals', () => {
  // Canary: the API gives these refusals no code, so they are matched by their wording. A reworded
  // refusal would otherwise be shown as an ordinary failure with every other test still passing.
  it('are worded as the kernel words them', () => {
    expect(kernelSource('spaces.ts')).toContain(NOT_A_MEMBER_MESSAGE)
    expect(kernelSource('spaces.ts')).toContain(INVALID_SPACE_ID_MESSAGE)
  })

  it('are told apart from any other failure', () => {
    expect(isNotAMemberError(new Error(NOT_A_MEMBER_MESSAGE))).toBe(true)
    expect(isNotAMemberError(new Error(INVALID_SPACE_ID_MESSAGE))).toBe(true)
    for (const other of [new Error('A space must keep at least one admin.'), 'refused', null]) {
      expect(isNotAMemberError(other)).toBe(false)
    }
  })
})
