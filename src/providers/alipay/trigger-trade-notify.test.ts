import type { IntegrationReceiveContext } from "../../triggers/common/integration.ts";
import type { JsonValue } from "../../triggers/common/types.ts";

import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PermanentIntegrationError } from "../../triggers/common/integration.ts";
import { canonicalAlipayString } from "./runtime.ts";
import { tradeNotify } from "./trigger-trade-notify.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

const now = new Date(1730419200000);

const notification: Record<string, string> = {
  app_id: "2021000000000000",
  trade_no: "2024110122001400001234",
  out_trade_no: "order-1",
  trade_status: "TRADE_SUCCESS",
  total_amount: "12.34",
  notify_id: "notify-1",
  notify_time: "2024-11-01 23:30:05",
  sign_type: "RSA2",
};

const baseConfig: Readonly<Record<string, JsonValue>> = {
  alipayPublicKey: publicKeyPem,
  tradeStatuses: ["TRADE_SUCCESS", "TRADE_FINISHED"],
};

function signedFields(fields: Record<string, string>, keyPem: string = privateKeyPem): Record<string, string> {
  const withoutSign: Record<string, string> = { ...fields };
  delete withoutSign.sign;
  return {
    ...fields,
    sign: createSign("RSA-SHA256").update(canonicalAlipayString(withoutSign)).sign(keyPem, "base64"),
  };
}

function receiveContext(input: {
  config: Readonly<Record<string, JsonValue>>;
  fields: Record<string, string>;
}): IntegrationReceiveContext {
  return {
    bindingId: "binding-1",
    callbackSecret: "callback-secret",
    config: input.config,
    connector: { execute: async () => ({ status: 200, data: {} }) },
    current: true,
    admit: true,
    method: "POST",
    now,
    payload: { ...input.fields } as JsonValue,
    rawBody: new TextEncoder().encode(JSON.stringify(input.fields)),
    header: () => "application/json",
    query: () => undefined,
  };
}

describe("alipay trade_notify receive", () => {
  it("accepts a correctly signed notification and emits normalized outputs", async () => {
    const fields = signedFields(notification);
    const result = await tradeNotify.receive(receiveContext({ config: baseConfig, fields }));

    expect(result).toMatchObject({
      outcome: "event",
      dedupeKey: "notify-1",
      outputs: {
        tradeNo: "2024110122001400001234",
        outTradeNo: "order-1",
        tradeStatus: "TRADE_SUCCESS",
        notifyId: "notify-1",
      },
    });
    const outputs = (result as { outputs: Record<string, unknown> }).outputs;
    expect(outputs.body).toEqual(fields);
  });

  it("rejects a tampered signature", async () => {
    const fields = signedFields(notification);
    fields.total_amount = "9999.00";

    const result = await tradeNotify.receive(receiveContext({ config: baseConfig, fields }));

    expect(result).toMatchObject({ outcome: "respond", status: 401, body: "failure" });
  });

  it("rejects a signature from a foreign key", async () => {
    const foreign = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const foreignPem = foreign.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const fields = signedFields(notification, foreignPem);

    const result = await tradeNotify.receive(receiveContext({ config: baseConfig, fields }));

    expect(result).toMatchObject({ outcome: "respond", status: 401 });
  });

  it("rejects non-RSA2 sign types", async () => {
    const fields = signedFields({ ...notification, sign_type: "RSA" });
    fields.sign_type = "RSA";

    const result = await tradeNotify.receive(receiveContext({ config: baseConfig, fields }));

    expect(result).toMatchObject({ outcome: "respond", status: 401 });
  });

  it("rejects deliveries without a signature", async () => {
    const result = await tradeNotify.receive(receiveContext({ config: baseConfig, fields: { ...notification } }));

    expect(result).toMatchObject({ outcome: "respond", status: 401 });
  });

  it("rejects deliveries when no Alipay public key is configured", async () => {
    const config: Readonly<Record<string, JsonValue>> = { alipayPublicKey: "", tradeStatuses: ["TRADE_SUCCESS"] };
    const fields = signedFields(notification);

    const result = await tradeNotify.receive(receiveContext({ config, fields }));

    expect(result).toMatchObject({ outcome: "respond", status: 401 });
  });

  it("ignores trade statuses outside the subscription", async () => {
    const config: Readonly<Record<string, JsonValue>> = {
      alipayPublicKey: publicKeyPem,
      tradeStatuses: ["TRADE_FINISHED"],
    };
    const fields = signedFields(notification);

    const result = await tradeNotify.receive(receiveContext({ config, fields }));

    expect(result).toMatchObject({ outcome: "ignored", reason: "Alipay trade status is not subscribed." });
  });

  it("emits events without a notify id but without a dedupe key", async () => {
    const fields = signedFields({ ...notification, notify_id: "" });

    const result = (await tradeNotify.receive(receiveContext({ config: baseConfig, fields }))) as Record<
      string,
      unknown
    >;

    expect(result).toMatchObject({ outcome: "event" });
    expect(result.dedupeKey ?? undefined).toBeUndefined();
  });
});

describe("alipay trade_notify reconcile", () => {
  it("accepts a signed business failure as proof the credential works", async () => {
    const calls: Array<{ endpoint: string; method: string; body?: unknown }> = [];
    const saved: Array<Record<string, unknown>> = [];
    const result = await tradeNotify.reconcile({
      active: true,
      callbackSecret: "callback-secret",
      config: baseConfig,
      connector: {
        execute: async (request) => {
          calls.push(request);
          return {
            status: 200,
            data: {
              alipay_trade_query_response: { code: "40004", msg: "Business Failed", sub_code: "ACQ.TRADE_NOT_EXIST" },
            },
          };
        },
      },
      endpointUrl: "https://flow.example/callback",
      idempotencyKey: "key-1",
      now,
      state: stateSpy(saved),
    });

    expect(result).toMatchObject({ outcome: "ready" });
    expect(calls).toEqual([
      {
        endpoint: "/",
        method: "POST",
        body: { method: "alipay.trade.query", bizContent: { out_trade_no: "__connector_reconcile__" } },
      },
    ]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toHaveProperty("verifiedAt");
  });

  it("fails permanently when the application credential is rejected", async () => {
    const promise = tradeNotify.reconcile({
      active: true,
      callbackSecret: "callback-secret",
      config: baseConfig,
      connector: {
        execute: async () => ({ status: 200, data: { error_response: { code: "40002", msg: "Illegal Signature" } } }),
      },
      endpointUrl: "https://flow.example/callback",
      idempotencyKey: "key-1",
      now,
      state: stateSpy([]),
    });

    await expect(promise).rejects.toBeInstanceOf(PermanentIntegrationError);
  });

  it("clears the subscription state on deactivation without remote calls", async () => {
    const calls: unknown[] = [];
    const saved: Array<Record<string, unknown>> = [];
    const result = await tradeNotify.reconcile({
      active: false,
      callbackSecret: "callback-secret",
      config: baseConfig,
      connector: {
        execute: async (request) => {
          calls.push(request);
          return { status: 200, data: {} };
        },
      },
      endpointUrl: "https://flow.example/callback",
      idempotencyKey: "key-1",
      now,
      state: stateSpy(saved),
    });

    expect(result).toMatchObject({ outcome: "ready" });
    expect(calls).toHaveLength(0);
    expect(saved).toEqual([{}]);
  });
});

interface SaveSpy {
  checkpoint: JsonValue;
  subscription: Readonly<Record<string, JsonValue>>;
  saveCheckpoint: (checkpoint: JsonValue) => Promise<void>;
  saveSubscription: (subscription: Readonly<Record<string, JsonValue>>, reconcileAt: Date) => Promise<void>;
}

function stateSpy(saved: Array<Record<string, unknown>>): SaveSpy {
  return {
    checkpoint: null,
    subscription: {},
    saveCheckpoint: async () => undefined,
    saveSubscription: async (subscription) => {
      saved.push({ ...subscription });
    },
  };
}
