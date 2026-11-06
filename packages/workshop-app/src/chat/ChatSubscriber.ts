import { RpcTarget } from 'capnweb'
import type { AiChatSubscriber } from '@gadgets/workshop-shared/api'

/** The notifications this app acts on. Code changes (`changeApplied`) are not part of it. */
export type ChatEvents = Pick<AiChatSubscriber, 'streamGeneration' | 'metadata' | 'message' | 'stream' | 'deleted'>

/**
 * What the server calls with chat activity. A class, because the server must receive a single stub
 * for the object; a plain object would arrive as a separate stub per method.
 */
export class ChatSubscriber extends RpcTarget implements AiChatSubscriber {
  constructor(private readonly events: ChatEvents) {
    super()
  }

  streamGeneration(generation: number) {
    this.events.streamGeneration(generation)
  }

  metadata(...args: Parameters<AiChatSubscriber['metadata']>) {
    this.events.metadata(...args)
  }

  message(...args: Parameters<AiChatSubscriber['message']>) {
    this.events.message(...args)
  }

  stream(...args: Parameters<AiChatSubscriber['stream']>) {
    this.events.stream(...args)
  }

  deleted(...args: Parameters<AiChatSubscriber['deleted']>) {
    this.events.deleted(...args)
  }

  changeApplied() {}
}
