import { useState, type FormEvent } from 'react'
import { Banner, Input } from '@cloudflare/kumo'
import { Button } from '@/components/Button'
import { Mascot } from '@/components/mascot/Mascot'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'

export type SignInFormProps = {
  /** Resolves to why it failed, or to nothing once signed in. */
  onSignIn: (username: string, password: string) => Promise<string | undefined>
}

// 16px at least on a phone, which zooms in on a field with smaller text when it is focused.
const FIELD_TEXT = 'max-md:text-[16px]'

/**
 * A username and password, in the middle of the page. Stays busy once signed in, until whoever
 * shows it puts it away.
 */
export const SignInForm = ({ onSignIn }: SignInFormProps) => {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  useDocumentTitle('Sign in')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!username || !password || busy) return
    setBusy(true)
    setProblem(undefined)
    const failure = await onSignIn(username, password)
    if (failure === undefined) return
    setProblem(failure)
    setBusy(false)
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
          <h1 className="text-xl font-semibold text-kumo-default">Sign in</h1>
        </div>
        <Input
          label="Username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoFocus
          autoComplete="username"
          className={FIELD_TEXT}
          disabled={busy}
        />
        <Input
          label="Password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          className={FIELD_TEXT}
          disabled={busy}
        />
        {problem && <Banner role="alert" variant="error" title={problem} />}
        <Button type="submit" variant="primary" disabled={!username || !password || busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  )
}
