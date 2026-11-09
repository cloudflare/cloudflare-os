// The API attaches no code to a space's refusals, so the ones the UI treats specially are
// recognized by the server's wording, which `spaceErrors.test.ts` holds to the kernel's source.

/** What a space answers a user it does not count as a member, as the kernel words it. */
export const NOT_A_MEMBER_MESSAGE = 'No such space, or you are not a member of it.'

/** What the server answers for a string that is not a space id, as the kernel words it. */
export const INVALID_SPACE_ID_MESSAGE = 'Invalid space id.'

const messageOf = (err: unknown) => (err instanceof Error ? err.message : '')

/**
 * Whether `err` says the user has no such space: the refusal a space gives a user it does not
 * count as a member, which the server gives for an id that names no space too, or its refusal
 * of a string that is no space id at all. None of them says whether the space exists.
 */
export const isNotAMemberError = (err: unknown): boolean => {
  const message = messageOf(err)
  return message.includes(NOT_A_MEMBER_MESSAGE) || message.includes(INVALID_SPACE_ID_MESSAGE)
}
