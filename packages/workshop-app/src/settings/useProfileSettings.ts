import { Mail01Icon, UserIcon } from '@/components/icons'
import { validateCommitEmail } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'
import type { TextSetting } from './settingDefinition'

/** The Profile settings that are a line of text, kept with the account. */
export const useProfileSettings = () => {
  const { api, user, userChanged } = useApi()

  const displayName: TextSetting = {
    kind: 'text',
    section: 'profile',
    title: 'Display name',
    description: 'What others see you as.',
    keywords: ['name', 'username', 'profile'],
    icon: UserIcon,
    remote: true,
    value: user.name,
    placeholder: 'Display name',
    set: async (name) => {
      await api.setOwnDisplayName(name)
      userChanged({ ...user, name })
    },
  }
  const commitEmail: TextSetting = {
    kind: 'text',
    section: 'profile',
    title: 'Commit email',
    description: 'The author email on your changes. Leave empty to use one generated from your user ID.',
    keywords: ['author', 'git', 'address', 'profile'],
    icon: Mail01Icon,
    remote: true,
    value: user.commitEmail ?? '',
    placeholder: 'name@example.com',
    type: 'email',
    optional: true,
    set: async (email) => {
      if (email) validateCommitEmail(email)
      await api.setOwnCommitEmail(email || null)
      userChanged({ ...user, commitEmail: email || undefined })
    },
  }
  return { displayName, commitEmail }
}
