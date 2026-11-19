import type { ReactNode } from 'react'
import { Select, type SelectOption } from '@/components/Select'
import { Tooltip } from '@/components/Tooltip'
import { formatCost, formatExactCost, formatTokenCount } from '@/components/usageFormat'

export type ComposerStatusLineProps = {
  /** The model that answers. Left out while the models are being read, and for a user who has none. */
  model?: {
    value: string
    options: SelectOption<string>[]
    onChange: (id: string) => void
  }
  /** What the chat's context holds, against what the model can hold. Either may be unknown. */
  context?: {
    /** Tokens in the context at the last step, once one has measured it. */
    used?: number
    /** The most the model is held to, where that is known. */
    window?: number
    /** Of all the prompt tokens sent, those read from the provider's cache and written to it. */
    cacheRead?: number
    cacheWrite?: number
    /** The window can be changed to one of these. Left out where it is not the user's to change. */
    sizes?: { value: string; options: SelectOption<string>[]; onChange: (choice: string) => void }
  }
  /** What the chat has cost, in dollars. */
  cost?: number
  /** Why the last change was not made. */
  problem?: string
}

const exact = (tokens: number) => tokens.toLocaleString()

/** What the context holds, and in brackets how much of the window that is: 83.3K (42%). Just the tokens where the window is not known. */
const contextText = ({ used, window }: NonNullable<ComposerStatusLineProps['context']>) => {
  if (used === undefined) return undefined
  if (window === undefined || window <= 0) return formatTokenCount(used)
  const share = (used / window) * 100
  return `${formatTokenCount(used)} (${share > 0 && share < 0.5 ? '<1' : Math.round(share)}%)`
}

const ContextDetails = ({ context }: { context: NonNullable<ComposerStatusLineProps['context']> }) => {
  const { used, window, cacheRead, cacheWrite, sizes } = context
  return (
    <>
      <span className="block">
        {used === undefined ? 'Not measured yet.' : window === undefined ? `${exact(used)} tokens in the context.` : `${exact(used)} of ${exact(window)} tokens (${((used / window) * 100).toFixed(1)}%).`}
      </span>
      {(cacheRead !== undefined || cacheWrite !== undefined) && (
        <span className="block">Cache: {exact(cacheRead ?? 0)} tokens read, {exact(cacheWrite ?? 0)} written.</span>
      )}
      {window !== undefined && <span className="block">{sizes ? 'Changing the size applies to every chat on this model.' : 'The model’s own size; the deployment may compact sooner.'}</span>}
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
