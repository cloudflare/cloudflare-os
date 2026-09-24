import { abortAllDurableObjects, env, runInDurableObject, SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { GatekeeperUserImpl, type UserAccount, type WebhookReceiver } from "../../src/webhook.js";
import webhookConfigurator from "../../src/configurator/webhook-configurator-ui.js";
import type { TestGadget, TestWorkshop } from "../worker.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    WEBHOOK_ACCOUNT: DurableObjectNamespace<UserAccount>;
    TEST_GADGET: DurableObjectNamespace<TestGadget>;
    TEST_WORKSHOP: DurableObjectNamespace<TestWorkshop>;
    WEBHOOK_RECEIVER: DurableObjectNamespace<WebhookReceiver>;
  }
}

it("refuses to configure an unknown webhook URL without adopting its endpoint ID", async () => {
  const account = env.WEBHOOK_ACCOUNT.getByName("configurator-account");
  await runInDurableObject(account, async instance => {
    const props = { accountId: instance.ctx.id.toString() };
    const context = new Proxy(instance.ctx, {
      get(target, property) {
        if (property === "props") return props;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DurableObjectState<typeof props>;
    const user = new GatekeeperUserImpl(context, env);
    const pattern = "http://localhost:8787/gatekeeper/webhook/hooks/:endpointId";
    const frame = await user.startResourceConfigurator(pattern);
    using ui = frame.ui;

    const endpointId = crypto.randomUUID();
    const url = await ui.resourceUrl(endpointId, "Known endpoint");
    const known = await webhookConfigurator.initialValuesFromResourceUrl({
      resourceUrl: url, resourceUrlPattern: pattern, ui,
    });
    expect(known).toMatchObject({ endpointId, label: "Known endpoint", endpointError: null });
    expect(webhookConfigurator.isReady({ values: known })).toBe(true);

    const unknownId = crypto.randomUUID();
    const unknown = await webhookConfigurator.initialValuesFromResourceUrl({
      resourceUrl: url.replace(endpointId, unknownId), resourceUrlPattern: pattern, ui,
    });
    expect(unknown).toMatchObject({ endpointId: null, label: null });
    expect(unknown.endpointError).toMatch(/could not verify/i);
    expect(webhookConfigurator.isReady({ values: unknown })).toBe(false);
    expect(await instance.getEndpoint(unknownId)).toBeNull();
  });
});

it("delivers through a restored Gadget callback before and after Durable Object restart", async () => {
  const endpointId = "00000000-0000-4000-8000-000000000099";
  let workshop = env.TEST_WORKSHOP.getByName("integration-workshop");
  const credential = await workshop.configure(endpointId);

  const send = (id: string) => SELF.fetch(credential.url, {
    method: "POST",
    headers: {
      [credential.headerName]: credential.headerValue,
      "Content-Type": "application/json",
      "Idempotency-Key": id,
    },
    body: JSON.stringify({ issue: { id }, symptom: "Worker error rate increased" }),
  });

  expect((await send("before-restart")).status).toBe(204);
  expect(await workshop.read()).toEqual({ startCount: 1, authorizationCount: 2 });
  let gadget = env.TEST_GADGET.getByName("integration-gadget");
  expect(await gadget.readDeliveries()).toMatchObject([
    { payload: { issue: { id: "before-restart" } } },
  ]);

  await abortAllDurableObjects();
  workshop = env.TEST_WORKSHOP.getByName("integration-workshop");
  gadget = env.TEST_GADGET.getByName("integration-gadget");
  // The pool's symbol-method bridge registers the reconstructed Gadget instance on first access.
  expect(await gadget.readDeliveries()).toHaveLength(1);

  expect((await send("after-restart")).status).toBe(204);
  expect(await workshop.read()).toEqual({ startCount: 2, authorizationCount: 3 });
  expect(await gadget.readDeliveries()).toMatchObject([
    { payload: { issue: { id: "before-restart" } } },
    { payload: { issue: { id: "after-restart" } } },
  ]);
});
