import {DurableObject} from "cloudflare:workers";
import type {WorktreeMount} from "@gadgets/workshop-shared/agent-integration";
import {decodePackStream} from "../src/git-codec";

/** Consume raw pack streams in a distinct Worker/DO, matching the integration boundary. */
export class TestReplicaTransfer extends DurableObject {
  async transfer(mount: WorktreeMount) {
    const objects = [];
    for (const pack of mount.packs) {
      await new Promise(resolve => setTimeout(resolve, 10));
      for await (const object of decodePackStream(pack, {maxPackSize: 1024 * 1024, maxObjectSize: 1024 * 1024}))
        objects.push({oid: object.oid, type: object.type, bytes: object.payload.length,
          binary: object.payload.includes(0)});
    }
    await mount.writeback.submitChanges("return", [{path: "return.txt", change: {set: "from other Worker"}}], true);
    return {head: mount.head, objects};
  }
}
