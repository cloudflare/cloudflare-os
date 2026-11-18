type Breakable = { onRpcBroken(callback: (error: unknown) => void): void }

/**
 * `promise`, as an RPC call's result is before it resolves (Cap'n Web's `RpcPromise`): a stub in
 * its own right, which can be disposed and told when it breaks without being awaited first. For
 * fakes of a call whose result the app uses that way. Disposing it disposes what it resolves to,
 * and its failing to resolve breaks it.
 */
export const pipelined = <T extends Disposable & Breakable>(promise: Promise<T>): Promise<T> & Disposable & Breakable =>
  Object.assign(promise, {
    [Symbol.dispose]: () => void promise.then((resolved) => resolved[Symbol.dispose](), () => {}),
    onRpcBroken: (callback: (error: unknown) => void) => void promise.then((resolved) => resolved.onRpcBroken(callback), callback),
  })
