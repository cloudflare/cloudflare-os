import { useState } from 'react'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Does what the user asked for, and keeps why the last thing asked for was not done. Nothing is
 * tried while the connection is down: the notice says so, and everything stays as it was.
 */
export const useAttempt = () => {
  const notice = useConnectionNotice()
  const [problem, setProblem] = useState<string>()
  /** Resolves to whether it was done. `what` finishes "Couldn’t …". */
  const attempt = async (what: string, action: () => Promise<unknown>) => {
    setProblem(undefined)
    if (notice?.blocked()) return false
    try {
      await action()
      return true
    } catch (error) {
      setProblem(`Couldn’t ${what}: ${messageOf(error)}`)
      return false
    }
  }
  return { problem, attempt }
}
