import type { FormEvent, ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { Banner, type BannerProps } from '@/components/Banner'
import { Button } from '@/components/Button'
import { Mascot, type MascotEmotion } from '@/components/mascot/Mascot'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'

export type OnboardingFrameProps = {
  emotion: MascotEmotion
  title: string
  subtitle?: string
  /** Which step this is, from 0, of how many: one step alone shows none. */
  step: { at: number; of: number }
  /** What did not work, over the buttons. */
  problem?: BannerProps
  /** Back to the step before; none on the first. */
  onBack?: () => void
  /** On to the next step, or to the app from the last; also what Enter does in a field. */
  next: { label: string; busy?: boolean; disabled?: boolean; onSelect: () => void }
  /** What is worth knowing of going on, under the buttons. */
  note?: string
  children: ReactNode
}

/**
 * A step of setting up, in the middle of the window as the sign-in page is: the mascot over what
 * the step is for, which of the steps it is, what is asked, and the way on, with the way back to
 * the step before at the other end. Each step fades in in place of the last (key it by its step).
 */
export const OnboardingFrame = ({ emotion, title, subtitle, step, problem, onBack, next, note, children }: OnboardingFrameProps) => {
  useDocumentTitle('Welcome')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!next.busy && !next.disabled) next.onSelect()
  }
  return (
    // Its column no wider than the window, whatever is in it: a service's name is cut short rather
    // than pushing the page out sideways.
    <div className="grid h-full grid-cols-[minmax(0,1fr)] place-items-center overflow-y-auto bg-kumo-canvas p-6">
      <form onSubmit={submit} className="appears flex w-full max-w-sm min-w-0 flex-col gap-6">
        <div className="flex flex-col items-center gap-5 text-center">
          {/* As on the sign-in page: small on a mostly empty page, so it notices a pointer from well away. */}
          <Mascot emotion={emotion} color="brand" interactive reach={4} className="w-12" />
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold text-kumo-default">{title}</h1>
            {subtitle && <p className="text-base text-kumo-subtle">{subtitle}</p>}
          </div>
          {step.of > 1 && (
            <ol aria-label={`Step ${step.at + 1} of ${step.of}`} className="flex items-center gap-1.5">
              {Array.from({ length: step.of }, (_, index) => (
                <li
                  key={index}
                  aria-current={index === step.at ? 'step' : undefined}
                  className={cn('h-1.5 rounded-full transition-[width,background-color] duration-300 motion-reduce:transition-none', index === step.at ? 'w-6 bg-kumo-contrast' : 'w-1.5 bg-kumo-contrast/20')}
                />
              ))}
            </ol>
          )}
        </div>
        {children}
        <div className="flex flex-col gap-3">
          {problem && <Banner {...problem} />}
          <div className="flex items-center justify-between gap-3">
            {onBack ? <Button variant="ghost" disabled={next.busy} onClick={onBack}>Back</Button> : <span />}
            <Button type="submit" variant="primary" disabled={next.busy || next.disabled}>{next.label}</Button>
          </div>
          {note && <p className="text-center text-sm text-kumo-subtle">{note}</p>}
        </div>
      </form>
    </div>
  )
}
