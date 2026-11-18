import type { AdminFormat, BlueprintOutput, BlueprintPublicInfo, BlueprintUserSummary } from '@gadgets/workshop-shared/api'

/** A blueprint that could be offered as a format, with what it says it makes where that is known. */
export type Promotable = { id: string; title: string; declared?: BlueprintOutput }

/**
 * The blueprints that could be offered as formats and are not yet: the deployment's featured ones,
 * which say what they make, then the admin's own published ones, which the server does not say of.
 */
export const promotableOf = (featured: BlueprintPublicInfo[], own: BlueprintUserSummary[], formats: AdminFormat[]): Promotable[] => {
  const byId = new Map<string, Promotable>()
  for (const blueprint of featured) byId.set(blueprint.id, { id: blueprint.id, title: blueprint.metadata.title, declared: blueprint.metadata.output })
  for (const blueprint of own) if (!byId.has(blueprint.id)) byId.set(blueprint.id, { id: blueprint.id, title: blueprint.title })
  const promoted = new Set(formats.map(({ blueprintId }) => blueprintId))
  return [...byId.values()].filter(({ id }) => !promoted.has(id))
}

/**
 * What a field that overrides what the blueprint declares is kept as: nothing (null) for an empty
 * one or one that says what the blueprint does, which then follows the blueprint, rather than
 * freezing what it says today into the deployment's settings.
 */
export const overrideOf = <Value extends string>(typed: Value | '', declared: Value | undefined): Value | null =>
  typed === '' || typed === declared ? null : typed

/** The formats' order with the one at `index` moved by `delta` places, or nothing where that is off the end. */
export const movedOrder = (ids: string[], index: number, delta: number): string[] | undefined => {
  const to = index + delta
  if (index < 0 || index >= ids.length || to < 0 || to >= ids.length) return undefined
  const order = [...ids]
  ;[order[index], order[to]] = [order[to], order[index]]
  return order
}

/** The formats people are offered, in order: those switched on whose blueprint is there and says what it makes. */
export const offeredOf = (formats: AdminFormat[]) => formats.filter((format) => format.enabled && format.output && !format.missing)

/**
 * The line the agent's catalog has for a format, as the server writes it (the Overseer's
 * `#listStandardFormats`): what it is called, and the hint, if there is one, at its end.
 */
export const catalogLine = (noun: string, hint: string) => `“${noun}” — a standard format on this deployment${hint ? ` -- ${hint}` : ''}`
