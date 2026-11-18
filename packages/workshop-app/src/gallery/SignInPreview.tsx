import { useState, type ReactNode } from 'react'
import { HandoffMessage } from '@/blocks/HandoffMessage'
import { SignInForm, type SignInChoices, type SignInMode, type SignInVendor } from '@/blocks/SignInForm'
import { useReport } from './previewState'
import { Section } from './Section'

const VENDORS: SignInVendor[] = [
  { id: 'cloudflare', name: 'Cloudflare', logoUrl: '/favicon.svg' },
  { id: 'google', name: 'Google' },
]

/** A window's worth of the page, as it is drawn in place of the app. */
const Frame = ({ children }: { children: ReactNode }) => (
  <div className="h-[36rem] w-[22rem] overflow-hidden rounded-2xl ring-1 ring-kumo-line">{children}</div>
)

type Offer = Pick<SignInChoices, 'password' | 'signUpOffered' | 'signUpClosed' | 'vendors'> & { startsAt?: SignInMode; vendorProblem?: string }

/** The page as a deployment offers it, working: a service's sign-in stays under way until another is chosen. */
const Choices = ({ startsAt = 'signIn', vendorProblem, ...offer }: Offer) => {
  const { report, later, say } = useReport()
  const [mode, setMode] = useState(startsAt)
  const [pending, setPending] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-2">
      <Frame>
        <SignInForm
          siteName="Cloudflare OS"
          state="ready"
          mode={mode}
          onModeChange={setMode}
          {...offer}
          signUpClosed={mode === 'signUp' && offer.signUpClosed}
          pendingVendor={pending}
          vendorProblem={pending === null ? vendorProblem ?? null : null}
          onVendor={(id) => {
            setPending(id)
            say(`sign in with ${id}`)
          }}
          onSignIn={async (username) => {
            await later()
            return username === 'ada' ? (say('signed in'), undefined) : 'Invalid username or password'
          }}
          onCreateAccount={async (username) => {
            await later()
            return username === 'taken' ? 'Username already exists' : (say(`made ${username}`), undefined)
          }}
        />
      </Frame>
      <p className="w-[22rem] text-sm text-kumo-subtle">{report}</p>
    </div>
  )
}

/** The sign-in page in each of its states, and what a sign-in window says once it is over. */
export const SignInPreview = () => {
  const { say } = useReport()
  return (
    <>
      <Section title="SignInForm (a password, with the way to make an account; “ada” signs in, anyone else is refused. Making an account says what is wrong with each field as it is typed; “taken” is taken)">
        <Choices password signUpOffered signUpClosed={false} vendors={[]} />
        <Choices password signUpOffered signUpClosed={false} vendors={[]} startsAt="signUp" />
      </Section>
      <Section title="SignInForm (a password and the services the deployment allows, one of which did not work; the services alone, where there is no password; making an account where the deployment takes none, which only a service can do)">
        <Choices password signUpOffered signUpClosed={false} vendors={VENDORS} vendorProblem="The sign-in expired. Try again." />
        <Choices password={false} signUpOffered={false} signUpClosed={false} vendors={VENDORS} />
        <Choices password={false} signUpOffered={false} signUpClosed vendors={VENDORS} startsAt="signUp" />
      </Section>
      <Section title="SignInForm (what the deployment allows being read, and not read; Cloudflare Access signing the user in, and failing to)">
        <Frame><SignInForm siteName="Cloudflare OS" state="loading" /></Frame>
        <Frame><SignInForm siteName="Cloudflare OS" state="failed" onRetry={() => say('read again')} /></Frame>
        <Frame><SignInForm siteName="Acme Workshop" state="access" /></Frame>
        <Frame><SignInForm siteName="Acme Workshop" state="access" problem="Your Cloudflare Access session has expired." onRetry={() => say('try again')} /></Frame>
      </Section>
      <Section title="HandoffMessage (a sign-in or connect window: finishing, done, and turned down)">
        <Frame><HandoffMessage /></Frame>
        <Frame><HandoffMessage outcome={{ title: 'Signed in', detail: 'You can close this window.' }} /></Frame>
        <Frame><HandoffMessage outcome={{ title: 'Couldn’t sign in', detail: 'This sign-in has expired. Start again from the app.' }} /></Frame>
      </Section>
    </>
  )
}
