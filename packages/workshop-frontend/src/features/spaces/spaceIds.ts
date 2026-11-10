/**
 * Whether `text` has the shape of a space id: 64 hex digits, as the server spells the id it
 * makes for a space (`SpaceInfo.id`). A string of any other shape names no space, so a page
 * asked for one shows that there is nothing there without asking the server. Whether a string
 * of this shape names a space, and one the user is a member of, is the server's to say (see
 * `isNotAMemberError`).
 */
export const couldBeSpaceId = (text: string): boolean => /^[0-9a-f]{64}$/i.test(text)
