// @ts-check

import { DurableObject } from "cloudflare:workers";

export class Gadget extends DurableObject {
  async ping() {
    return "ok";
  }
}
