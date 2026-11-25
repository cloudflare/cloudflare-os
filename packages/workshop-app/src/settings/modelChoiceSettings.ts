import { ChipIcon, FlashIcon } from '@/components/icons'
import { defaultModelOf } from '@/chat/defaultModel'
import type { ChoiceSetting } from './settingDefinition'
import type { ModelSettingsState } from './useModelSettings'

// Chosen for no model. No model is called this.
const NONE = '::none'

/**
 * The two models the user chooses among their models: the one that answers by default, which is the
 * first of them until one is chosen, and the one for small tasks, which may be none. Given the
 * models as they are read, they are there before it: with nothing to choose from, and said to be
 * `unavailable` while they are being read or if they could not be.
 */
export const modelChoiceSettings = (
  state: ModelSettingsState,
  { setPreferred, setQuick }: { setPreferred: (id: string) => Promise<void>; setQuick: (id: string | null) => Promise<void> },
): { defaultModel: ChoiceSetting; quickModel: ChoiceSetting } => {
  const ready = state.status === 'ready' ? state : undefined
  const models = ready?.models ?? []
  const options = models.map(({ id, name }) => ({ id, label: name }))
  const unavailable: ChoiceSetting['unavailable'] = state.status === 'loading'
    ? { status: 'loading' }
    : state.status === 'failed'
      ? { status: 'failed', message: `Couldn’t load models: ${state.message.replace(/\.+$/, '')}`, retry: state.retry }
      : undefined
  const quick = ready?.quick ?? null

  return {
    defaultModel: {
      kind: 'choice',
      section: 'models',
      title: 'Default model',
      description: 'Answers each message you send, in new chats and in ones you already have. A reply that is already under way keeps the model it started with.',
      keywords: ['answers', 'chat', 'ai', 'llm'],
      icon: ChipIcon,
      remote: true,
      value: (ready && defaultModelOf(models, ready.preferred)?.id) || '',
      options,
      placeholder: 'No models',
      searchable: true,
      unavailable,
      set: setPreferred,
    },
    quickModel: {
      kind: 'choice',
      section: 'models',
      title: 'Quick model',
      description: 'Used for small tasks, such as naming chats. With none, chats stay untitled.',
      keywords: ['small', 'tasks', 'naming', 'titles', 'ai', 'llm'],
      icon: FlashIcon,
      remote: true,
      value: quick ?? NONE,
      options: [{ id: NONE, label: 'None' }, ...options],
      // One chosen that is no longer offered.
      placeholder: quick ?? 'None',
      searchable: true,
      unavailable,
      set: (id) => setQuick(id === NONE ? null : id),
    },
  }
}
