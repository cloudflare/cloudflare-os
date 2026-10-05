// The API attaches no code to a space's refusals, so the two the UI treats specially are recognized
// by the server's wording, which `spaceErrors.test.ts` holds to the kernel's source.

/** What a space answers a user it does not count as a member, as the kernel words it. */
export const NOT_A_MEMBER_MESSAGE = 'No such space, or you are not a member of it.'

/** What `createSpace` answers for a key that has already been claimed, as the kernel words it. */
export const KEY_TAKEN_MESSAGE = 'A space with this key already exists.'

const messageOf = (err: unknown) => (err instanceof Error ? err.message : '')

/**
 * Whether `err` is the refusal a space gives a user it does not count as a member. The server
 * gives the same one for a key no space has claimed, so it does not say whether the space exists.
 */
export const isNotAMemberError = (err: unknown): boolean =>
  messageOf(err).includes(NOT_A_MEMBER_MESSAGE)

/** Whether `err` is `createSpace` refusing a key that has already been claimed. */
export const isKeyTakenError = (err: unknown): boolean =>
  messageOf(err).includes(KEY_TAKEN_MESSAGE)
