/** What a new account is asked for: its username, and its password twice. */
export type NewAccount = { username: string; password: string; confirm: string }

/** As the backend and `workshop-frontend` ask of a new password. */
export const MIN_PASSWORD_LENGTH = 8

/**
 * What is wrong with each of a new account's fields, in `workshop-frontend`'s sign-up page's words:
 * nothing for one that is empty, which is not wrong yet.
 */
export const newAccountProblems = ({ username, password, confirm }: NewAccount) => ({
  username: username && !/^[a-z0-9_-]+$/i.test(username) ? 'Letters, numbers, underscores, and hyphens only' : undefined,
  password: password && password.length < MIN_PASSWORD_LENGTH ? `Must be at least ${MIN_PASSWORD_LENGTH} characters` : undefined,
  confirm: confirm && confirm !== password ? 'Passwords do not match' : undefined,
})

/** Whether a new account can be asked for: every field filled in, and none of them wrong. */
export const canCreateAccount = (account: NewAccount) => {
  const problems = newAccountProblems(account)
  return Boolean(account.username && account.password && account.confirm) && !problems.username && !problems.password && !problems.confirm
}
