import type { IntegrationReceiveContext } from "../../triggers/common/integration.ts";
import type { JsonValue } from "../../triggers/common/types.ts";

import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PermanentIntegrationError } from "../../triggers/common/integration.ts";
import { paymentNotify } from "./trigger-payment-notify.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

const now = new Date(1730419200000);

const notification = {
  id: "EV-201802251833666",
  event_type: "TRANSACTION.SUCCESS",
  summary: "支付成功",
  mchid: "1900000000",
  out_trade_no: "order-1",
  transaction_id: "4200001234202411010000000001",
  trade_state: "SUCCESS",
  resource: {
    original_type: "transaction",
    algorithm: "AEAD_AES_256_GCM",
    ciphertext: "abc",
    nonce: "xyz",
    associated_data: "transaction",
  },
};

function signedHeaders(bodyText: string, at: Date = now): Record<string, string> {
  const timestamp = Math.floor(at.getTime() / 1000).toString();
  const nonce = "nonce-1";
  const message = [timestamp, nonce, bodyText].join("\n");
  return {
    "wechatpay-timestamp": timestamp,
    "wechatpay-nonce": nonce,
    "wechatpay-signature": createSign("RSA-SHA256").update(message).sign(privateKeyPem, "base64"),
  };
}

function receiveContext(input: {
  config: Readonly<Record<string, JsonValue>>;
  headers: Record<string, string>;
  bodyText: string;
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
    payload: JSON.parse(input.bodyText) as JsonValue,
    rawBody: new TextEncoder().encode(input.bodyText),
    header: (name) => input.headers[name.toLowerCase()],
    query: () => undefined,
  };
}

const baseConfig: Readonly<Record<string, JsonValue>> = {
  platformCertificate: publicKeyPem,
  eventTypes: ["*"],
};

describe("wechatpay payment_notify receive", () => {
  it("accepts a correctly signed notification and emits normalized outputs", async () => {
    const bodyText = JSON.stringify(notification);
    const result = await paymentNotify.receive(
      receiveContext({ config: baseConfig, headers: signedHeaders(bodyText), bodyText }),
    );

    expect(result).toMatchObject({
      outcome: "event",
      dedupeKey: notification.id,
      outputs: {
        event: "TRANSACTION.SUCCESS",
        eventId: notification.id,
        mchid: "1900000000",
        outTradeNo: "order-1",
        transactionId: notification.transaction_id,
        tradeState: "SUCCESS",
      },
    });
    const outputs = (result as { outputs: Record<string, unknown> }).outputs;
    expect(outputs.body).toEqual(notification);
  });

  it("rejects a tampered signature with a FAIL response", async () => {
    const bodyText = JSON.stringify(notification);
    const headers = signedHeaders(bodyText);
    headers["wechatpay-signature"] = Buffer.from("forged").toString("base64");

    const result = await paymentNotify.receive(receiveContext({ config: baseConfig, headers, bodyText }));

    expect(result).toMatchObject({ outcome: "respond", status: 401 });
    expect(JSON.parse((result as { body: string }).body)).toMatchObject({ code: "FAIL" });
  });

  it("rejects when the body is modified after signing", async () => {
    const headers = signedHeaders(JSON.stringify(notification));
    const bodyText = JSON.stringify({ ...notification, trade_state: "REFUND" });

    const result = await paymentNotify.receive(receiveContext({ config: baseConfig, headers, bodyText }));

    expect(result).toMatchObject({ outcome: "respond", status: 401 });
  });

  it("rejects notifications outside the replay tolerance", async () => {
    const stale = new Date(now.getTime() - 6 * 60 * 1000);
    const bodyText = JSON.stringify(notification);

    const result = await paymentNotify.receive(
      receiveContext({ config: baseConfig, headers: signedHeaders(bodyText, stale), bodyText }),
    );

    expect(result).toMatchObject({ outcome: "respond", status: 401 });
  });

  it("rejects deliveries missing signature headers", async () => {
    const bodyText = JSON.stringify(notification);

    const result = await paymentNotify.receive(receiveContext({ config: baseConfig, headers: {}, bodyText }));

    expect(result).toMatchObject({ outcome: "respond", status: 401 });
  });

  it("rejects deliveries when no platform certificate is configured", async () => {
    const bodyText = JSON.stringify(notification);
    const config: Readonly<Record<string, JsonValue>> = { platformCertificate: "", eventTypes: ["*"] };

    const result = await paymentNotify.receive(receiveContext({ config, headers: signedHeaders(bodyText), bodyText }));

    expect(result).toMatchObject({ outcome: "respond", status: 401 });
  });

  it("ignores event types outside the subscription", async () => {
    const bodyText = JSON.stringify(notification);
    const config: Readonly<Record<string, JsonValue>> = {
      platformCertificate: publicKeyPem,
      eventTypes: ["REFUND.SUCCESS"],
    };

    const result = await paymentNotify.receive(receiveContext({ config, headers: signedHeaders(bodyText), bodyText }));

    expect(result).toMatchObject({ outcome: "ignored", reason: "WeChat Pay event type is not subscribed." });
  });
});

describe("wechatpay payment_notify reconcile", () => {
  it("verifies the merchant credential through the provider proxy when active", async () => {
    const calls: Array<{ endpoint: string; method: string }> = [];
    const saved: Array<Record<string, unknown>> = [];
    const result = await paymentNotify.reconcile({
      active: true,
      callbackSecret: "callback-secret",
      config: baseConfig,
      connector: {
        execute: async (request) => {
          calls.push(request);
          return { status: 200, data: { data: [] } };
        },
      },
      endpointUrl: "https://flow.example/callback",
      idempotencyKey: "key-1",
      now,
      state: stateSpy(saved),
    });

    expect(result).toMatchObject({ outcome: "ready" });
    expect(calls).toEqual([{ endpoint: "/v3/certificates", method: "GET" }]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toHaveProperty("verifiedAt");
  });

  it("fails permanently when the merchant credential is rejected", async () => {
    const promise = paymentNotify.reconcile({
      active: true,
      callbackSecret: "callback-secret",
      config: baseConfig,
      connector: { execute: async () => ({ status: 401, data: {} }) },
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
    const result = await paymentNotify.reconcile({
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
