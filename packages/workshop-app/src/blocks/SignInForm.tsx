import { useState, type FormEvent, type ReactNode } from 'react'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { Mascot, type MascotEmotion } from '@/components/mascot/Mascot'
import { TextField } from '@/components/TextField'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { canCreateAccount, newAccountProblems } from './newAccount'

/** Whether the page is signing in to an account there is, or making one. */
export type SignInMode = 'signIn' | 'signUp'

/** A service that can be signed in with. */
export type SignInVendor = { id: string; name: string; logoUrl?: string }

/** What the page offers, as the deployment allows. */
export type SignInChoices = {
  mode: SignInMode
  onModeChange: (mode: SignInMode) => void
  /** A username and password: to sign in with, or to make an account with. */
  password: boolean
  /** Signing in: the way to make an account instead. */
  signUpOffered: boolean
  /** Making an account: the deployment takes no new ones, which is said. */
  signUpClosed: boolean
  /** Each a button, under the password where there is one. */
  vendors: SignInVendor[]
  /** The service being signed in with: no other can be chosen meanwhile. */
  pendingVendor: string | null
  /** Why signing in with a service did not work. */
  vendorProblem: string | null
  onVendor: (id: string) => void
  /** Resolves to why it failed, or to nothing once signed in. */
  onSignIn: (username: string, password: string) => Promise<string | undefined>
  /** Resolves to why it failed, or to nothing once made and signed in to. */
  onCreateAccount: (username: string, password: string) => Promise<string | undefined>
}

export type SignInFormProps = {
  /** What the deployment calls itself. */
  siteName: string
} & (
  /** What the deployment allows is being read. */
  | { state: 'loading' }
  /** What the deployment allows could not be read. */
  | { state: 'failed'; onRetry: () => void }
  /** Signing in as whoever Cloudflare Access says, with why it did not work once it has not. */
  | { state: 'access'; problem?: string; onRetry?: () => void }
  | ({ state: 'ready' } & SignInChoices)
)

/** The mascot over a heading and what is said under it, in the middle of the page. */
const Page = ({ emotion, title, subtitle, children }: { emotion: MascotEmotion; title: string; subtitle?: string; children?: ReactNode }) => (
  <div className="grid h-full place-items-center overflow-y-auto bg-kumo-canvas p-6">
    <div className="flex w-full max-w-xs flex-col gap-4">
      <div className="mb-2 flex flex-col items-center gap-5 text-center">
        {/* As on the home page: small on a mostly empty page, so it notices a pointer from well away. */}
        <Mascot emotion={emotion} color="brand" interactive reach={4} className="w-12" />
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-kumo-default">{title}</h1>
          {subtitle && <p className="text-base text-kumo-subtle">{subtitle}</p>}
        </div>
      </div>
      {children}
    </div>
  </div>
)

/**
 * The sign-in page, in the middle of the window: what the deployment is called, and the ways in it
 * allows. A username and password, to sign in with or, where the deployment takes new accounts, to
 * make one with; then a button for each service that can be signed in with; then the way between
 * signing in and making an account. Until it is known what the deployment allows it says so, as it
 * does while Cloudflare Access is signing the user in. Stays busy once signed in, until whoever
 * shows it puts it away.
 */
export const SignInForm = (props: SignInFormProps) => {
  const { siteName } = props
  useDocumentTitle(props.state === 'ready' && props.mode === 'signUp' ? 'Create account' : 'Sign in')
  switch (props.state) {
    case 'loading':
      return <Page emotion="thinking" title={siteName} subtitle="Loading…" />
    case 'failed':
      return (
        <Page emotion="error" title={siteName}>
          <Banner title="Couldn’t load deployment settings." action={{ label: 'Try again', onSelect: props.onRetry }} />
        </Page>
      )
    case 'access':
      return props.problem === undefined ? (
        <Page emotion="thinking" title={siteName} subtitle="Signing in with Cloudflare Access…" />
      ) : (
        <Page emotion="error" title={siteName}>
          <Banner
            title="Couldn’t sign in"
            description={props.problem}
            action={props.onRetry && { label: 'Try again', onSelect: props.onRetry }}
          />
        </Page>
      )
    case 'ready':
      // A page of its own for each, so that what was typed in one is not in the other.
      return <SignInChoicesPage key={props.mode} {...props} />
  }
}

const SignInChoicesPage = ({ siteName, ...choices }: SignInChoices & { siteName: string }) => {
  const { mode, password: hasPassword, vendors, pendingVendor, vendorProblem } = choices
  const signingUp = mode === 'signUp'
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()

  const account = { username, password, confirm }
  const fieldProblems: Partial<ReturnType<typeof newAccountProblems>> = signingUp ? newAccountProblems(account) : {}
  const ready = signingUp ? canCreateAccount(account) : Boolean(username && password)
  const waiting = busy || pendingVendor !== null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready || waiting) return
    setBusy(true)
    setProblem(undefined)
    const failure = await (signingUp ? choices.onCreateAccount : choices.onSignIn)(username, password)
    if (failure === undefined) return
    setProblem(failure)
    setBusy(false)
  }

  return (
    <Page
      emotion={waiting ? 'thinking' : problem || vendorProblem ? 'error' : 'idle'}
      title={siteName}
      subtitle={signingUp ? 'Create your account' : 'Sign in to your account'}
    >
      {choices.signUpClosed && (
        <p className="rounded-2xl bg-kumo-tint p-4 text-base text-kumo-subtle">
          <span className="block font-medium text-kumo-default">Signups are closed</span>
          New account registration is currently disabled on this deployment.
        </p>
      )}
      {hasPassword && (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field problem={fieldProblems.username}>
            <TextField
              label="Username"
              value={username}
              onValueChange={setUsername}
              autoFocus
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              invalid={fieldProblems.username !== undefined}
              disabled={busy}
            />
          </Field>
          <Field problem={fieldProblems.password}>
            <TextField
              label="Password"
              type="password"
              value={password}
              onValueChange={setPassword}
              autoComplete={signingUp ? 'new-password' : 'current-password'}
              invalid={fieldProblems.password !== undefined}
              disabled={busy}
            />
          </Field>
          {signingUp && (
            <Field problem={fieldProblems.confirm}>
              <TextField
                label="Confirm password"
                type="password"
                value={confirm}
                onValueChange={setConfirm}
                autoComplete="new-password"
                invalid={fieldProblems.confirm !== undefined}
                disabled={busy}
              />
            </Field>
          )}
          {problem && <Banner title={problem} />}
          <Button type="submit" variant="primary" disabled={!ready || waiting}>
            {signingUp ? (busy ? 'Creating account…' : 'Create account') : busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      )}
      {vendors.length > 0 && (
        <div className="flex flex-col gap-3">
          {hasPassword && (
            <div className="flex items-center gap-3 text-sm text-kumo-subtle">
              <span className="h-px flex-1 bg-kumo-line" />
              or
              <span className="h-px flex-1 bg-kumo-line" />
            </div>
          )}
          {vendorProblem && <Banner title={vendorProblem} />}
          {vendors.map((vendor) => (
            <Button
              key={vendor.id}
              icon={vendor.logoUrl ? <img src={vendor.logoUrl} alt="" className="size-[1.125em] object-contain" /> : undefined}
              disabled={waiting}
              onClick={() => choices.onVendor(vendor.id)}
            >
              {pendingVendor === vendor.id ? `Continuing with ${vendor.name}…` : `Continue with ${vendor.name}`}
            </Button>
          ))}
        </div>
      )}
      {(choices.signUpOffered || signingUp) && (
        <p className="mt-2 text-center text-base text-kumo-subtle">
          {signingUp ? 'Already have an account? ' : 'Don’t have an account? '}
          <button
            type="button"
            disabled={busy}
            onClick={() => choices.onModeChange(signingUp ? 'signIn' : 'signUp')}
            className="font-medium text-kumo-default underline underline-offset-2 disabled:opacity-50"
          >
            {signingUp ? 'Sign in' : 'Create one'}
          </button>
        </p>
      )}
    </Page>
  )
}

/** A field, with what is wrong with what was typed in it under it. */
const Field = ({ problem, children }: { problem?: string; children: ReactNode }) => (
  <div className="flex flex-col gap-1.5">
    {children}
    {problem && <p className="text-sm text-kumo-danger">{problem}</p>}
  </div>
)
