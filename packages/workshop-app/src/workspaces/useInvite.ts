import { useEffect, useState } from 'react'
import type { CollaboratorInfo, CollaboratorRole } from '@gadgets/workshop-shared/api'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import type { SharingSession } from './SharingSession'

/** What the last invite did: why it failed, why it changed nothing, or who was just let in. */
export type InviteFeedback = { tone: 'error' | 'info' | 'success'; message: string }

// How long someone just let in is lit up in the list, before it lets go.
const LANDED_FOR = 1200

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Inviting one person at a time from a sharing dialog: what is typed, whether it is out, what came
 * of it, and who was just let in. A typed name that would change nothing says why without asking
 * the server, and nothing is tried over a lost connection.
 */
export const useInvite = ({ session, refusal, admitted }: {
  session: SharingSession
  /** Why inviting them with this role would change nothing, if it would not. */
  refusal: (userId: string, role: CollaboratorRole) => string | undefined
  /** What to say of someone let in. */
  admitted: (person: CollaboratorInfo, role: CollaboratorRole) => string
}) => {
  const connection = useConnectionNotice()
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<InviteFeedback>()
  const [landed, setLanded] = useState<string>()

  useEffect(() => {
    if (landed === undefined) return
    const timer = setTimeout(() => setLanded(undefined), LANDED_FOR)
    return () => clearTimeout(timer)
  }, [landed])

  const invite = async (userId: string, role: CollaboratorRole) => {
    if (pending || connection?.blocked()) return
    const refused = refusal(userId, role)
    if (refused) return setFeedback({ tone: 'info', message: refused })
    setPending(true)
    setFeedback(undefined)
    try {
      const person = await session.invite(userId, role)
      if (!person) return setFeedback({ tone: 'error', message: 'There’s no account with that username or email.' })
      setValue('')
      setFeedback({ tone: 'success', message: admitted(person, role) })
      setLanded(person.profile.id)
    } catch (error) {
      setFeedback({ tone: 'error', message: messageOf(error) })
    } finally {
      setPending(false)
    }
  }

  return {
    value,
    // What it says is about what was typed, so typing something else puts it away.
    setValue: (next: string) => {
      setValue(next)
      if (feedback?.tone !== 'success') setFeedback(undefined)
    },
    pending,
    feedback,
    landed,
    invite: (userId: string, role: CollaboratorRole) => void invite(userId, role),
  }
}
