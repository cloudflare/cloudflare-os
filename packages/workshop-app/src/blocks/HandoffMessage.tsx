export type HandoffMessageProps = {
  /** How it went, once that is known: until then it says it is finishing. */
  outcome?: { title: string; detail: string }
}

/** What a popup that ended on `/connect/handoff` says, alone in the middle of its window. */
export const HandoffMessage = ({ outcome }: HandoffMessageProps) => (
  <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
    <h1 className="text-lg font-medium text-kumo-default">{outcome?.title ?? 'Finishing up…'}</h1>
    {outcome && <p className="text-base text-kumo-subtle">{outcome.detail}</p>}
  </div>
)
