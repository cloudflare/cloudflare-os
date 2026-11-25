import { Delete02Icon, Image03Icon } from '@/components/icons'
import type { SearchEntry } from '@/blocks/SearchDialog'
import { useApi } from '@/rpc/ApiContext'
import { ownAvatar } from '../OwnAvatar'
import { useOwnAvatar } from '../useOwnAvatar'
import { useRequireConnection } from './useRequireConnection'

const GROUP = 'Profile'

/**
 * What the Profile settings offer of the picture. A new one is chosen on the Profile settings,
 * which `onOpenProfile` goes to, as search has no way to open the file picker and see it through.
 */
export const usePictureEntries = (onOpenProfile: () => void): SearchEntry[] => {
  const { api, user } = useApi()
  const hasPicture = useOwnAvatar() !== undefined
  const requireConnection = useRequireConnection()

  return [
    {
      key: 'setting:picture',
      group: GROUP,
      title: 'Change profile picture…',
      keywords: ['avatar', 'photo', 'image', 'profile'],
      icon: <Image03Icon />,
      onSelect: onOpenProfile,
    },
    ...(hasPicture
      ? [{
          key: 'setting:remove-picture',
          group: GROUP,
          title: 'Remove profile picture',
          keywords: ['avatar', 'photo', 'image', 'delete', 'profile'],
          icon: <Delete02Icon />,
          onSelect: async () => {
            requireConnection()
            await api.setAvatar(null)
            ownAvatar.set(user.id, null)
          },
        } satisfies SearchEntry]
      : []),
  ]
}
