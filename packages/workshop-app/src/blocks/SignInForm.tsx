import { useState, type FormEvent } from 'react'
import { Banner, Input } from '@cloudflare/kumo'
import { Button } from '@/components/Button'
import { Mascot } from '@/components/mascot/Mascot'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'

export type SignInFormProps = {
  /** Resolves to why it failed, or to nothing once signed in. */
  onSignIn: (username: string, password: string) => Promise<string | undefined>
  /**
   * Makes an account and signs in to it, resolving as `onSignIn` does. Left out where the
   * deployment does not let people make their own, and then not offered.
   */
  onCreateAccount?: (username: string, password: string) => Promise<string | undefined>
  /**
   * In development, after signing out, the dev account that signing in skips to otherwise, as a
   * way back to it.
   */
  devAccount?: { username: string; onContinue: () => void }
  /** Opens making an account rather than signing in. */
  initialMode?: 'signIn' | 'create'
}

// 16px at least on a phone, which zooms in on a field with smaller text when it is focused.
const FIELD_TEXT = 'max-md:text-[16px]'

// As the server takes a username (`normalizeUsername`), and a password as the existing Workshop's
// sign-up page did, before the server is asked.
const usernameProblem = (username: string) =>
  username && !/^[a-z][a-z0-9_]*$/i.test(username) ? 'A letter first, then letters, numbers or underscores' : undefined
const passwordProblem = (password: string) => (password && password.length < 8 ? 'At least 8 characters' : undefined)

/**
 * A username and password, in the middle of the page, to sign in; or, where the deployment allows
 * it, to make an account, with the password typed twice. Stays busy once signed in, until whoever
 * shows it puts it away.
 */
export const SignInForm = ({ onSignIn, onCreateAccount, devAccount, initialMode = 'signIn' }: SignInFormProps) => {
  const [mode, setMode] = useState(onCreateAccount ? initialMode : 'signIn')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const creating = mode === 'create' && onCreateAccount !== undefined
  useDocumentTitle(creating ? 'Create an account' : 'Sign in')

  const fieldProblems = creating
    ? { username: usernameProblem(username), password: passwordProblem(password), confirm: confirm && confirm !== password ? 'Doesn’t match' : undefined }
    : {}
  const ready = Boolean(username && password && (!creating || confirm)) && !Object.values(fieldProblems).some(Boolean)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setProblem(undefined)
    const failure = await (creating ? onCreateAccount(username, password) : onSignIn(username, password))
    if (failure === undefined) return
    setProblem(failure)
    setBusy(false)
  }

  const switchTo = (next: 'signIn' | 'create') => {
    setMode(next)
    setProblem(undefined)
    setConfirm('')
  }

  return (
    <div className="grid h-full place-items-center overflow-y-auto bg-kumo-canvas p-6">
      <form onSubmit={submit} className="flex w-full max-w-xs flex-col gap-4">
        <div className="mb-2 flex flex-col items-center gap-5">
          {/* As on the home page: small on a mostly empty page, so it notices a pointer from well away. */}
          <Mascot
            emotion={busy ? 'thinking' : problem ? 'error' : 'idle'}
            color="brand"
            interactive
            reach={4}
            className="w-12"
          />
          <h1 className="text-xl font-semibold text-kumo-default">{creating ? 'Create an account' : 'Sign in'}</h1>
        </div>
        <Input
          label="Username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoFocus
          autoComplete="username"
          className={FIELD_TEXT}
          disabled={busy}
          error={fieldProblems.username}
        />
        <Input
          label="Password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete={creating ? 'new-password' : 'current-password'}
          className={FIELD_TEXT}
          disabled={busy}
          error={fieldProblems.password}
        />
        {creating && (
          <Input
            label="Confirm password"
            type="password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="new-password"
            className={FIELD_TEXT}
            disabled={busy}
            error={fieldProblems.confirm}
          />
        )}
        {problem && <Banner role="alert" variant="error" title={problem} />}
        <Button type="submit" variant="primary" disabled={!ready || busy}>
          {creating ? (busy ? 'Creating…' : 'Create account') : (busy ? 'Signing in…' : 'Sign in')}
        </Button>
        {onCreateAccount && (
          // Faded in, as whether it is offered is known only once the deployment has said.
          <p className="appears text-center text-sm text-kumo-subtle">
            {creating ? 'Have an account? ' : 'New here? '}
            <button
              type="button"
              disabled={busy}
              onClick={() => switchTo(creating ? 'signIn' : 'create')}
              className="rounded-sm font-medium text-kumo-default underline-offset-2 outline-none hover:underline focus-visible:underline disabled:opacity-60"
            >
              {creating ? 'Sign in' : 'Create an account'}
            </button>
          </p>
        )}
        {devAccount && (
          <Button variant="ghost" className="self-center" disabled={busy} onClick={devAccount.onContinue}>
            Continue as {devAccount.username}
          </Button>
        )}
      </form>
    </div>
  )
}
