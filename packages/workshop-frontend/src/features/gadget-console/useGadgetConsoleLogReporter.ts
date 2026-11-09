import { useLayoutEffect, useRef } from 'react'
import type { RpcStub } from 'capnweb'
import type { ConsoleLogEvent, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { useConnectionLost } from '../../RpcContext'
import { createGadgetConsoleLogReporter, type GadgetConsoleLogReporter } from './gadgetConsoleLogReporter'

/**
 * Sends what a gadget view's frame logs to the view's workspace, in batches, and returns the
 * function that takes each captured call.
 *
 * A queue is sent through the latest `overseer` this hook was given, so that a view goes on
 * reporting when an outage replaces its workspace's stub. That makes the caller responsible for
 * one thing: a view must unmount when its workspace changes, never re-render with another
 * workspace's stub, or its queue would be sent to that workspace under this gadget's id.
 *
 * Nothing is sent while the Workshop's connection is lost (useConnectionLost()): the queue is
 * kept, its newest entries first, and goes out once the connection is back. A batch sent
 * meanwhile would wait for the new connection and be delivered then, after the reporter had
 * given it up and counted it as dropped. `overseer` is null only where a workspace has no
 * connection at all (it has not opened, or failed to), which keeps the queue the same way.
 *
 * Two things a view holds as it goes away are lost, and nothing marks them. A user who moves from
 * one workspace straight to another has the first one's stub disposed one commit before its view
 * unmounts, so that view's last batch, at most one interval of entries, is refused as a
 * connection failure. And a view that unmounts while the connection is lost has nothing to send
 * its queue through: at most the newest MAX_GADGET_CONSOLE_LOGS_PER_CALL - 1 entries, with the
 * count of earlier drops they carried.
 */
export const useGadgetConsoleLogReporter = (
  overseer: RpcStub<Overseer> | null,
  gadgetId: WorkpieceId,
  chatId: number | undefined,
): ((log: ConsoleLogEvent) => void) => {
  const overseerRef = useRef(overseer)
  overseerRef.current = overseer
  const connectionLostRef = useRef(false)
  connectionLostRef.current = useConnectionLost()
  const reporterRef = useRef<GadgetConsoleLogReporter | null>(null)

  // A layout effect, because the reporter's last send must reach the workspace's stub before the
  // stub is disposed. The editor's workspace hook disposes it in a passive effect's cleanup, and
  // React runs the layout cleanups of a removed tree before its passive ones, so stopping here
  // sends the last batch on a live stub when the view goes away with the route, with its gadget
  // or with its draft. A call made just before a stub is disposed still runs on the server.
  useLayoutEffect(() => {
    const reporter = createGadgetConsoleLogReporter(entries =>
      // Through an outage the stub is never null: once the loss is noticed it is one pipelined on
      // the connection being made, on which a call does not fail but waits, and is delivered when
      // the connection is made. Every batch sent through it would be given up, counted as
      // dropped and followed by a marker that waits in its turn, and all of them would be
      // recorded together at the end. So the connection's state decides, and nothing else: not
      // the stub being null, which it is not, and not a rejection, which does not come.
      connectionLostRef.current
        ? null
        : overseerRef.current?.reportGadgetConsoleLogs(gadgetId, chatId ?? null, entries) ?? null)
    reporterRef.current = reporter

    // The last chance to send before a tab closes.
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') reporter.flush()
    }
    document.addEventListener('visibilitychange', flushWhenHidden)

    return () => {
      document.removeEventListener('visibilitychange', flushWhenHidden)
      reporterRef.current = null
      reporter.stop()
    }
  }, [gadgetId, chatId])

  return log => reporterRef.current?.add(log)
}
