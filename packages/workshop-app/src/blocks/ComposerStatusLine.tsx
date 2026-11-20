import type { ReactNode } from 'react'
import { Select, type SelectOption, Tooltip } from '@gadgets/ui'
import { formatCost, formatExactCost, formatTokenCount } from '@/components/usageFormat'

export type ComposerStatusLineProps = {
  /** The model that answers. Left out while the models are being read, and for a user who has none. */
  model?: {
    value: string
    options: SelectOption<string>[]
    onChange: (id: string) => void
  }
  /** What the chat's context holds, as the server measured it. */
  context?: {
    /**
     * How full the context was at the last step, once one has measured it: its tokens, against the
     * prompt budget the chat compacts against on the model the step ran on, named as shown.
     */
    measured?: { tokens: number; budget: number; model: string }
    /** The share of the budget at which the chat compacts. */
    compactsAt?: number
    /** Of all the prompt tokens sent, those read from the provider's cache and written to it. */
    cacheRead?: number
    cacheWrite?: number
    /** The model's window can be changed to one of these. Left out where it is not the user's to change. */
    sizes?: { value: string; options: SelectOption<string>[]; onChange: (choice: string) => void }
  }
  /** What the chat has cost, in dollars. */
  cost?: number
  /** Why the last change was not made. */
  problem?: string
}

const exact = (tokens: number) => tokens.toLocaleString()

/** What the context holds, and in brackets how much of the budget that is: 83.3K (42%). */
const contextText = ({ measured }: NonNullable<ComposerStatusLineProps['context']>) => {
  if (measured === undefined) return undefined
  const share = (measured.tokens / measured.budget) * 100
  return `${formatTokenCount(measured.tokens)} (${share > 0 && share < 0.5 ? '<1' : Math.round(share)}%)`
}

const ContextDetails = ({ context }: { context: NonNullable<ComposerStatusLineProps['context']> }) => {
  const { measured, compactsAt, cacheRead, cacheWrite, sizes } = context
  return (
    <>
      <span className="block">
        {measured === undefined ? 'Not measured yet.' : `${exact(measured.tokens)} of ${exact(measured.budget)} tokens (${((measured.tokens / measured.budget) * 100).toFixed(1)}%), on ${measured.model}.`}
      </span>
      {measured !== undefined && compactsAt !== undefined && <span className="block">The chat compacts at {Math.round(compactsAt * 100)}%.</span>}
      {(cacheRead !== undefined || cacheWrite !== undefined) && (
        <span className="block">Cache: {exact(cacheRead ?? 0)} tokens read, {exact(cacheWrite ?? 0)} written.</span>
      )}
      {sizes && <span className="block">Changing the size applies to every chat on this model, from its next step.</span>}
    </>
  )
}

const Figure = ({ tip, children }: { tip: ReactNode; children: ReactNode }) => (
  <Tooltip content={tip}>
    <span tabIndex={0} className="rounded-full px-2.5 py-0.5 focus-visible:bg-kumo-contrast/5 focus-visible:outline-none">{children}</span>
  </Tooltip>
)

/**
 * What a chat is running on, under its composer, for those who build on the app: the model on the
 * left, which can be changed there, and on the right what the context holds and what the chat has
 * cost. Shortened figures, exact when pointed at.
 */
export const ComposerStatusLine = ({ model, context, cost, problem }: ComposerStatusLineProps) => {
  const text = context && (contextText(context) ?? (context.sizes ? 'Context size' : undefined))
  return (
    <div className="flex flex-col gap-0.5 px-1 text-xs text-kumo-subtle">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <div className="min-w-0 max-w-[60%]">
          {model && model.options.length > 0 && (
            <Select aria-label="Model" value={model.value} options={model.options} onValueChange={model.onChange} searchable={model.options.length > 8} compact={{ align: 'start', medium: true }} />
          )}
        </div>
        <div className="flex shrink-0 items-center">
          {context && text !== undefined && (
            context.sizes
              ? (
                  <Tooltip content={<ContextDetails context={context} />}>
                    <span className="flex">
                      <Select aria-label="Context window" value={context.sizes.value} options={context.sizes.options} onValueChange={context.sizes.onChange} compact={{ shown: text }} />
                    </span>
                  </Tooltip>
                )
              : <Figure tip={<ContextDetails context={context} />}>{text}</Figure>
          )}
          {cost !== undefined && <Figure tip={`${formatExactCost(cost)} spent on AI in this chat so far. May include estimates.`}>{formatCost(cost)}</Figure>}
        </div>
      </div>
      {problem && <p role="alert" className="px-2 text-xs text-kumo-danger">{problem}</p>}
    </div>
  )
}
