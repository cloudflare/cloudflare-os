import { RpcTarget } from "capnweb";

/** What a holder of `view` can reach over RPC: every string-named member of its class, and of
 * any class between it and RpcTarget. Cap'n Web exposes prototype members, never own ones. */
export function rpcSurface(view: object): Set<string> {
  let names = new Set<string>();
  for (let proto = Object.getPrototypeOf(view); proto !== RpcTarget.prototype;
       proto = Object.getPrototypeOf(proto)) {
    for (let name of Object.getOwnPropertyNames(proto)) names.add(name);
  }
  names.delete("constructor");
  return names;
}
