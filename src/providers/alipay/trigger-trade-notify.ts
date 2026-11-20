import type { IntegrationDefinition, IntegrationStateContext } from "../../triggers/common/integration.ts";
import type { JsonValue } from "../../triggers/common/types.ts";

import { optionalRecord } from "../../core/cast.ts";
import { PermanentIntegrationError, TransientIntegrationError } from "../../triggers/common/integration.ts";
import { isJsonObject } from "../../triggers/common/json.ts";
import { verifyAlipaySignature } from "./runtime.ts";
import { snapshot } from "./trigger-trade-notify.definition.ts";

interface Config {
  readonly alipayPublicKey: string;
  readonly tradeStatuses: readonly string[];
}

const permanentErrorCodes = new Set(["40002", "40003", "40005", "40006", "20001"]);

function resolveConfig(value: Readonly<Record<string, JsonValue>>): Config {
  return {
    alipayPublicKey: typeof value.alipayPublicKey === "string" ? value.alipayPublicKey : "",
    tradeStatuses: [...new Set((value.tradeStatuses as readonly string[]) ?? ["TRADE_SUCCESS", "TRADE_FINISHED"])],
  };
}

function later(date: Date): Date {
  return new Date(date.getTime() + 60_000);
}

function refuse(
  status: number,
  body: string,
): {
  readonly body: string;
  readonly contentType: string;
  readonly outcome: "respond";
  readonly status: number;
} {
  return { body, contentType: "text/plain", outcome: "respond", status };
}

function requireState(state: IntegrationStateContext | undefined): IntegrationStateContext {
  if (!state) throw new PermanentIntegrationError("Alipay trigger state is missing.");
  return state;
}

function readStringFields(payload: Readonly<Record<string, JsonValue>>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string") fields[key] = value;
  }
  return fields;
}

export const tradeNotify: IntegrationDefinition = {
  initialState: { checkpoint: null, subscription: {} },
  snapshot,
  async receive(context) {
    const config = resolveConfig(context.config);
    if (!isJsonObject(context.payload)) {
      return refuse(400, "failure");
    }
    const fields = readStringFields(context.payload as Readonly<Record<string, JsonValue>>);
    const signature = fields.sign;
    if (!signature || (fields.sign_type && fields.sign_type !== "RSA2")) {
      return refuse(401, "failure");
    }
    if (config.alipayPublicKey.length === 0) {
      return refuse(401, "failure");
    }
    // Official async notification verification: RSA2 over the sorted `k=v&`
    // canonical string of every non-empty field except sign and sign_type.
    // The ingress adapter delivers the form-encoded notification as a JSON
    // object of string fields (deployment prerequisite, see trigger-permissions).
    if (
      !verifyAlipaySignature({ alipayPublicKeyPem: config.alipayPublicKey, params: fields, signatureBase64: signature })
    ) {
      return refuse(401, "failure");
    }
    const tradeStatus = fields.trade_status ?? "";
    if (!config.tradeStatuses.includes(tradeStatus)) {
      return { outcome: "ignored", reason: "Alipay trade status is not subscribed." };
    }
    const notifyId = fields.notify_id;
    return {
      dedupeKey: notifyId && notifyId.length > 0 ? notifyId : undefined,
      outcome: "event",
      outputs: {
        body: context.payload as Readonly<Record<string, JsonValue>>,
        tradeNo: fields.trade_no ?? null,
        outTradeNo: fields.out_trade_no ?? null,
        tradeStatus: tradeStatus.length > 0 ? tradeStatus : null,
        notifyId: notifyId ?? null,
      },
    };
  },
  async reconcile(context) {
    const state = requireState(context.state);
    if (!context.active) {
      // Alipay notification URLs are configured per application or per order,
      // so deactivation only cleans the local subscription record.
      await state.saveSubscription({}, later(context.now));
      return { outcome: "ready" };
    }
    // Prove the stored application credential still authenticates with a
    // signed query of a guaranteed-missing order; a signed business failure
    // (ACQ.TRADE_NOT_EXIST) still proves the RSA2 key pair is accepted.
    const result = await context.connector.execute(
      {
        endpoint: "/",
        method: "POST",
        body: { method: "alipay.trade.query", bizContent: { out_trade_no: "__connector_reconcile__" } },
      },
      context.signal,
    );
    const payload = result.status >= 200 && result.status < 300 ? optionalRecord(result.data) : undefined;
    const code = readResponseCode(payload);
    if (permanentErrorCodes.has(code)) {
      throw new PermanentIntegrationError("Alipay rejected the application credentials for this subscription.");
    }
    if (code === "20000") {
      throw new TransientIntegrationError("Alipay gateway is temporarily unavailable.");
    }
    if (result.status < 200 || result.status >= 300) {
      throw new TransientIntegrationError(`Alipay gateway check failed with HTTP ${result.status}.`);
    }
    await state.saveSubscription({ verifiedAt: context.now.toISOString() }, later(context.now));
    return { outcome: "ready" };
  },
};

function readResponseCode(payload: Record<string, unknown> | undefined): string {
  if (!payload) return "";
  const errorNode = optionalRecord(payload.error_response);
  const queryNode = optionalRecord(payload.alipay_trade_query_response);
  const node = errorNode ?? queryNode;
  const code = node?.code;
  return typeof code === "string" ? code : "";
}
