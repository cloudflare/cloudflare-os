// The capability the resource configurator frame talks to.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { AcmeConfiguratorRpc } from "./configurator/acme-configurator-types";

/**
 * Asks nothing of the provider: the frame parses the link the user pastes. A picker's lookups go
 * here, as narrow read-only methods; keep tokens and API clients in `#private` state.
 */
@validateRpc()
export class AcmeConfiguratorUI extends RpcTarget implements AcmeConfiguratorRpc {}
