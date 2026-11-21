import { ArrowDownIcon, ArrowUpIcon, DotsThreeIcon, FlaskIcon, SlidersHorizontalIcon, TrashIcon } from '@phosphor-icons/react'
import { GATEWAY_MODEL_MODES, modelKind, type AdminModelView, type GatewayModelMode } from '@gadgets/workshop-shared/api'
import { DropdownMenu, LIST_ACTION, Select, Tag } from '@gadgets/ui'
import { GatewayTestStatus } from './GatewayTest'
import { MODES, statedFacts, tokenCount } from './modelForm'
import type { GatewayTestState } from './useGatewayTests'

export type GatewayModelRowProps = {
  model: AdminModelView
  /** The catalog's name for the model it behaves like, where the catalog has it. */
  behavesLikeName?: string
  /** Where its last test stands. Absent until one is run. */
  test: GatewayTestState | undefined
  onModeChange: (mode: GatewayModelMode) => void
  /** Moves it one place along its provider's models, where it is not at that end already. */
  onMoveUp?: () => void
  onMoveDown?: () => void
  onTest: () => void
  onOpenSettings: () => void
  /** Asks whether to remove it. Only a model the deployment added. */
  onRemove?: () => void
}

/**
 * One gateway model, as a row of its provider's: its name, marked where it is a decision model,
 * one the deployment added, or changed from what the catalog has, over its ID and its limits, and
 * what it borrows or states; how it is offered at the end, then more, which tests it, opens its
 * settings, moves it along the list and removes one that was added. A decision model runs no chat,
 * so it has no test or settings. What a test found is under the rest.
 */
export const GatewayModelRow = ({ model, behavesLikeName, test, onModeChange, onMoveUp, onMoveDown, onTest, onOpenSettings, onRemove }: GatewayModelRowProps) => {
  const decision = modelKind(model.provider, model.id) === 'decision'
  const stated = statedFacts(model.capabilities)
  const facts = [`Context window ${tokenCount(model.contextWindow)}`, ...(model.outputLimit === undefined ? [] : [`output limit ${tokenCount(model.outputLimit)}`])]
  return (
    <li className="@container border-t border-kumo-line py-4 first:border-t-0">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="flex min-w-[min(100%,14rem)] flex-1 flex-col gap-1 leading-snug">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-kumo-default">
            <span className="wrap-anywhere">{model.name}</span>
            {decision && <Tag>Decision</Tag>}
            {model.added && <Tag>Added</Tag>}
            {(model.mode !== model.defaultMode || model.settings !== undefined) && <Tag>Changed</Tag>}
          </p>
          <p className="font-mono text-sm wrap-anywhere text-kumo-subtle">{model.id}</p>
          <p className="text-sm text-kumo-subtle">{facts.join(', ')}</p>
          {model.behavesLike !== undefined && (
            <p className="text-sm text-kumo-subtle">
              Behaves like {behavesLikeName ?? <span className="font-mono wrap-anywhere">{model.behavesLike}</span>}
              {model.runtimeKnown ? '. Not used: this version knows this model itself.' : model.behavesLikeKnown === false && '. This version no longer knows that model, so nothing is borrowed.'}
            </p>
          )}
          {stated.length > 0 && (
            <p className="text-sm text-kumo-subtle">
              Stated: {stated.join(', ')}{model.runtimeKnown && '. Not used: this version knows this model itself.'}
            </p>
          )}
          <GatewayTestStatus test={test} subject="model" />
        </div>
        <div className="flex max-w-full min-w-0 items-center gap-2 @lg:shrink-0 @lg:justify-end">
          <Select
            aria-label={`How ${model.name} is offered`}
            value={model.mode}
            options={GATEWAY_MODEL_MODES.map((mode) => ({ id: mode, label: mode === model.defaultMode ? `${MODES[mode].label} (default)` : MODES[mode].label }))}
            onValueChange={(mode) => {
              if (mode !== model.mode) onModeChange(mode)
            }}
          />
          <DropdownMenu icon={DotsThreeIcon} aria-label={`More for ${model.name}`} triggerVariant="ghost" triggerClassName={LIST_ACTION} align="end">
            {!decision && <DropdownMenu.Item icon={FlaskIcon} disabled={test?.state === 'testing'} onSelect={onTest}>Test</DropdownMenu.Item>}
            {!decision && <DropdownMenu.Item icon={SlidersHorizontalIcon} onSelect={onOpenSettings}>Settings…</DropdownMenu.Item>}
            <DropdownMenu.Item icon={ArrowUpIcon} disabled={!onMoveUp} onSelect={onMoveUp}>Move up</DropdownMenu.Item>
            <DropdownMenu.Item icon={ArrowDownIcon} disabled={!onMoveDown} onSelect={onMoveDown}>Move down</DropdownMenu.Item>
            {onRemove && (
              <>
                <DropdownMenu.Separator />
                <DropdownMenu.Item icon={TrashIcon} danger onSelect={onRemove}>Remove…</DropdownMenu.Item>
              </>
            )}
          </DropdownMenu>
        </div>
      </div>
    </li>
  )
}
