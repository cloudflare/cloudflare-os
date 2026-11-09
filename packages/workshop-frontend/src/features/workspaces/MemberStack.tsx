import type { AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { PersonAvatar } from '../../components/PersonAvatar'
import { useAuthenticatedApi } from '../../AuthContext'

/**
 * Up to three members' faces, overlapping (Figma "Frame 1"), each ringed in the surface color so
 * the overlap reads.
 */
export function MemberStack({ people, size = 18, overlap = 2 }: {
  people: AiChatAuthorInfo[]
  size?: number
  overlap?: number
}) {
  const { authenticatedApi } = useAuthenticatedApi()
  return (
    <span className="flex items-center" aria-label={people.map(p => p.name).join(', ')}>
      {people.slice(0, 3).map((person, index) => (
        <span
          key={person.id}
          className="rounded-full ring-2 ring-kumo-base"
          style={{ marginLeft: index === 0 ? 0 : -overlap, zIndex: 3 - index }}
          title={person.name}
        >
          <PersonAvatar api={authenticatedApi} userId={person.id} name={person.name} size={size} />
        </span>
      ))}
    </span>
  )
}
