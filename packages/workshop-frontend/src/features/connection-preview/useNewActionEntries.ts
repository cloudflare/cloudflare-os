import { useEffect, useRef } from 'react'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'
import { actionLogReplayed, useActionEntries } from '../../useActions'

/**
 * useActionEntries() without the entries from before the caller mounted, and without the last
 * one of a session it resumes: both are delivered again, and neither is new work.
 */
export const useNewActionEntries = (
  overseer: RpcStub<Overseer> | null,
  onEntry: (entry: ActionLogEntry) => void,
) => {
  const live = useRef(false)
  useActionEntries(overseer, entry => {
    if (live.current && !actionLogReplayed(overseer, entry)) onEntry(entry)
  })
  // After useActionEntries, so its replay has run by the time this is set: once for each overseer.
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [overseer])
}
