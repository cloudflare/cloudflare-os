// The workerd suite's Worker: the gatekeeper's own entrypoints, so miniflare can bind its Durable
// Objects, and `TestHost`, which runs each scenario against the gatekeeper as the overseer would.

import { GatekeeperTestHost } from "@gadgets/gatekeeper-kit/test-support";
import type { AcmeGatekeeperImplProps } from "../../src/acme-resources";

export { default } from "../../src/acme";
export * from "../../src/acme";

export class TestHost extends GatekeeperTestHost<AcmeGatekeeperImplProps> {
  protected gatekeeperClass(props: AcmeGatekeeperImplProps) {
    return this.ctx.exports.AcmeGatekeeperImpl({ props });
  }
}
