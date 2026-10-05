import { isValidTeamSpaceKey } from '@gadgets/workshop-shared/api'

// The longest key `TEAM_SPACE_KEY_PATTERN` accepts.
const MAX_TEAM_SPACE_KEY_LENGTH = 32

/** The team space key grammar in words, for the key field's help and its error. */
export const TEAM_SPACE_KEY_RULE =
  '2 to 32 lowercase letters, digits or dashes, starting with a letter or digit'

/**
 * The key a space name suggests: its letters and digits in lowercase, accents dropped, every run
 * of anything else a single dash. Empty when the name yields no valid key (one too short, or in a
 * script the grammar has no letters for), so a suggestion is never one the server would refuse.
 */
export const suggestSpaceKey = (name: string): string => {
  const key = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-/, '')
    .slice(0, MAX_TEAM_SPACE_KEY_LENGTH)
    .replace(/-$/, '')
  return isValidTeamSpaceKey(key) ? key : ''
}

/**
 * The space key a route's `space` search parameter carries, or undefined when it holds anything
 * `accepts` refuses, so a malformed link names no space. `accepts` is `isValidTeamSpaceKey` where
 * only a team space will do, `isValidSpaceKey` where a personal one will too.
 */
export const spaceKeyFromSearch = (
  value: unknown,
  accepts: (key: string) => boolean,
): string | undefined => (typeof value === 'string' && accepts(value) ? value : undefined)
