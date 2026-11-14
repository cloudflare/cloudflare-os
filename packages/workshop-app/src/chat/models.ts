import type { AiChatAuthorInfo } from '@gadgets/workshop-shared/api'

/** The models the user may chat with (`listModels`), and the one they prefer (`getPreferredModel`). */
export type Models =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | {
      status: 'ready'
      offered: readonly AiChatAuthorInfo[]
      /** The model a new chat starts with, if the user has chosen one; it may no longer be offered. */
      preferred: string | undefined
    }

/** The model a message goes to, or why there is none. */
export type ModelChoice =
  | { status: 'ready'; model: AiChatAuthorInfo }
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'failed'; message: string }

/**
 * The model a message goes to: the one chosen for it, else the chat's own (the one at work, or the
 * last that spoke), else the user's preferred, else the first offered. Each only while it is still
 * offered, so a chat whose model has gone carries on with the default rather than failing.
 */
export const modelFor = (models: Models, { picked, chat }: { picked?: string; chat?: string } = {}): ModelChoice => {
  if (models.status !== 'ready') return models
  const find = (id: string | undefined) => (id === undefined ? undefined : models.offered.find((model) => model.id === id))
  const model = find(picked) ?? find(chat) ?? find(models.preferred) ?? models.offered[0]
  return model ? { status: 'ready', model } : { status: 'none' }
}

/** What to tell the user when a message cannot be sent for lack of a model. */
export const describeModelProblem = (choice: Exclude<ModelChoice, { status: 'ready' }>) => {
  switch (choice.status) {
    case 'loading':
      return 'Your AI models are still loading. Try again in a moment.'
    case 'none':
      return 'No AI model is set up for your account.'
    case 'failed':
      return `Couldn’t load your AI models: ${choice.message}`
  }
}
