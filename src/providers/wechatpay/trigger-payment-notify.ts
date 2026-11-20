import type { IntegrationDefinition, IntegrationStateContext } from "../../triggers/common/integration.ts";
import type { JsonValue } from "../../triggers/common/types.ts";

import { PermanentIntegrationError, TransientIntegrationError } from "../../triggers/common/integration.ts";
import { isJsonObject } from "../../triggers/common/json.ts";
import { isFreshNotifyTimestamp, verifyWechatPayNotifySignature } from "./runtime.ts";
import { snapshot } from "./trigger-payment-notify.definition.ts";

interface Config {
  readonly platformCertificate: string;
  readonly eventTypes: readonly string[];
}

function resolveConfig(value: Readonly<Record<string, JsonValue>>): Config {
  return {
    platformCertificate: typeof value.platformCertificate === "string" ? value.platformCertificate : "",
    eventTypes: [...new Set((value.eventTypes as readonly string[]) ?? ["*"])],
  };
}

function later(date: Date): Date {
  return new Date(date.getTime() + 60_000);
}

function fail(
  status: number,
  message: string,
): {
  readonly body: string;
  readonly contentType: string;
  readonly outcome: "respond";
  readonly status: number;
} {
  return {
    body: JSON.stringify({ code: "FAIL", message }),
    contentType: "application/json",
    outcome: "respond",
    status,
  };
}

function requireState(state: IntegrationStateContext | undefined): IntegrationStateContext {
  if (!state) throw new PermanentIntegrationError("WeChat Pay trigger state is missing.");
  return state;
}

export const paymentNotify: IntegrationDefinition = {
  initialState: { checkpoint: null, subscription: {} },
  snapshot,
  async receive(context) {
    const config = resolveConfig(context.config);
    const timestamp = context.header("wechatpay-timestamp")?.trim() ?? "";
    const nonce = context.header("wechatpay-nonce")?.trim() ?? "";
    const signature = context.header("wechatpay-signature")?.trim() ?? "";
    if (!timestamp || !nonce || !signature) {
      return fail(401, "WeChat Pay notification is missing signature headers.");
    }
    if (!isFreshNotifyTimestamp(timestamp, context.now)) {
      return fail(401, "WeChat Pay notification timestamp is outside the replay tolerance.");
    }
    if (config.platformCertificate.length === 0) {
      return fail(401, "The subscription has no platform certificate configured for signature verification.");
    }
    const bodyText = new TextDecoder().decode(context.rawBody);
    if (
      !verifyWechatPayNotifySignature({
        platformCertificate: config.platformCertificate,
        timestamp,
        nonce,
        signatureBase64: signature,
        bodyText,
      })
    ) {
      return fail(401, "WeChat Pay notification signature verification failed.");
    }
    if (!isJsonObject(context.payload)) {
      return { outcome: "ignored", reason: "WeChat Pay notification body is not an object." };
    }
    const payload = context.payload as Readonly<Record<string, JsonValue>>;
    const eventId = payload.id;
    const event = payload.event_type;
    if (typeof eventId !== "string" || eventId.length === 0 || typeof event !== "string" || event.length === 0) {
      return { outcome: "ignored", reason: "WeChat Pay notification identity is missing." };
    }
    if (!config.eventTypes.includes("*") && !config.eventTypes.includes(event)) {
      return { outcome: "ignored", reason: "WeChat Pay event type is not subscribed." };
    }
    return {
      dedupeKey: eventId,
      outcome: "event",
      outputs: {
        body: payload,
        event,
        eventId,
        mchid: typeof payload.mchid === "string" ? payload.mchid : null,
        outTradeNo: typeof payload.out_trade_no === "string" ? payload.out_trade_no : null,
        transactionId: typeof payload.transaction_id === "string" ? payload.transaction_id : null,
        tradeState: typeof payload.trade_state === "string" ? payload.trade_state : null,
      },
    };
  },
  async reconcile(context) {
    const state = requireState(context.state);
    if (!context.active) {
      // WeChat Pay notify URLs are configured per order or in the merchant
      // platform, so deactivation only cleans the local subscription record.
      await state.saveSubscription({}, later(context.now));
      return { outcome: "ready" };
    }
    // Prove the stored merchant credential still authenticates by listing the
    // platform certificates; this needs a valid APIv3 signature and nothing else.
    const result = await context.connector.execute({ endpoint: "/v3/certificates", method: "GET" }, context.signal);
    if (result.status === 401 || result.status === 403) {
      throw new PermanentIntegrationError("WeChat Pay rejected the merchant credentials for this subscription.");
    }
    if (result.status < 200 || result.status >= 300) {
      throw new TransientIntegrationError(`WeChat Pay certificate check failed with HTTP ${result.status}.`);
    }
    await state.saveSubscription({ verifiedAt: context.now.toISOString() }, later(context.now));
    return { outcome: "ready" };
  },
};
