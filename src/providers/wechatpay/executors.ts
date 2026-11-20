import type { CredentialValidators, ProviderExecutors, ProviderProxyExecutor } from "../../core/types.ts";
import type { IntegrationDefinition } from "../../triggers/common/integration.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";
import type { WechatPayContext } from "./runtime.ts";

import { optionalString, requiredString } from "../../core/cast.ts";
import {
  defineProviderExecutors,
  defineProviderProxy,
  providerProxyEndpointPrefixes,
  ProviderRequestError,
  requireCustomCredential,
} from "../provider-runtime.ts";
import {
  buildWechatPayAuthorization,
  downloadWechatPayBill,
  readWechatPayCredential,
  wechatPayJsonRequest,
} from "./runtime.ts";
import { paymentNotify } from "./trigger-payment-notify.ts";

const service = "wechatpay";

type WechatPayActionHandler = (input: Record<string, unknown>, context: WechatPayContext) => Promise<unknown>;

/**
 * Read-only proxy surface: certificate list, settlement bills, and order
 * queries only. Refund and transfer domains stay unreachable so the whole
 * provider exposes no funds-moving face.
 */
const proxyEndpointPrefixes = providerProxyEndpointPrefixes(
  "/v3/certificates",
  "/v3/bill/tradebill",
  "/v3/bill/fundflowbill",
  "/v3/pay/transactions",
  "/v3/merchant/fund",
);

export const wechatPayActionHandlers: ProviderActionHandlers<"wechatpay", WechatPayActionHandler> = {
  async query_transaction(input, context) {
    const transactionId = optionalString(input.transactionId);
    const outTradeNo = optionalString(input.outTradeNo);
    let payload: Record<string, unknown>;
    if (transactionId) {
      payload = await wechatPayJsonRequest(
        context.credential,
        context.fetcher,
        {
          method: "GET",
          path: `/v3/pay/transactions/id/${encodeURIComponent(transactionId)}`,
          query: { mchid: context.credential.mchid },
        },
        context.signal,
      );
    } else {
      payload = await wechatPayJsonRequest(
        context.credential,
        context.fetcher,
        {
          method: "GET",
          path: `/v3/pay/transactions/out-trade-no/${encodeURIComponent(requiredString(outTradeNo, "outTradeNo", (message) => new ProviderRequestError(400, message)))}`,
          query: { mchid: context.credential.mchid },
        },
        context.signal,
      );
    }
    return {
      transaction: payload,
      transactionId: optionalString(payload.transaction_id) ?? null,
      outTradeNo: optionalString(payload.out_trade_no) ?? null,
      tradeState: optionalString(payload.trade_state) ?? null,
      amountTotal: readAmountTotal(payload),
      successTime: optionalString(payload.success_time) ?? null,
    };
  },
  async download_bill(input, context) {
    if (!context.transitFiles) {
      throw new ProviderRequestError(400, "wechatpay download_bill requires local transit file storage");
    }
    return downloadWechatPayBill(
      context.credential,
      context,
      {
        billDate: requiredString(input.billDate, "billDate", (message) => new ProviderRequestError(400, message)),
        billType: optionalString(input.billType) ?? "ALL",
        fileName: optionalString(input.fileName),
      },
      context.transitFiles,
    );
  },
};

function readAmountTotal(payload: Record<string, unknown>): number | null {
  const amount = payload.amount;
  if (typeof amount !== "object" || amount === null || Array.isArray(amount)) return null;
  const total = (amount as Record<string, unknown>).total;
  return typeof total === "number" && Number.isInteger(total) ? total : null;
}

// The egress host is the hardcoded literal `api.mch.weixin.qq.com` for every
// request this provider issues (the bill download URL is verified against the
// same host before fetching), so the redundant DNS resolved-address check is
// skipped following the hardcoded-host providers such as stripe. URL and
// redirect guards remain active.
export const executors: ProviderExecutors = defineProviderExecutors<WechatPayContext>({
  service,
  handlers: wechatPayActionHandlers,
  skipDnsValidation: true,
  async createContext(context, fetcher): Promise<WechatPayContext> {
    const credential = await requireCustomCredential(context, service);
    return {
      credential: readWechatPayCredential(credential.values),
      fetcher,
      signal: context.signal,
      transitFiles: context.transitFiles,
    };
  },
});

export const credentialValidators: CredentialValidators = {
  async customCredential(input, { fetcher, signal }) {
    const credential = readWechatPayCredential(input.values);
    // Listing platform certificates is the cheapest authenticated APIv3 call:
    // it only proves that the merchant key material signs correctly.
    try {
      await wechatPayJsonRequest(credential, fetcher, { method: "GET", path: "/v3/certificates" }, signal);
    } catch (error) {
      // A validate-phase rejection is a field error on the connect form, not a reconnect prompt.
      if (error instanceof ProviderRequestError && (error.status === 401 || error.status === 403)) {
        throw new ProviderRequestError(400, error.message);
      }
      throw error;
    }
    return {
      profile: {
        accountId: credential.mchid,
        displayName: `WeChat Pay merchant ${credential.mchid}`,
        grantedScopes: [],
      },
      grantedScopes: [],
      metadata: {
        apiBaseUrl: "https://api.mch.weixin.qq.com",
        validationEndpoint: "/v3/certificates",
        appId: credential.appId,
      },
    };
  },
};

export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  baseUrl: "https://api.mch.weixin.qq.com",
  auth: { type: "credential_headers", headers: [] },
  allowedEndpoint: proxyEndpointPrefixes,
  // See the executors note: hardcoded literal API host.
  skipDnsValidation: true,
  customizeRequest({ credential, method, url, body, setBody, headers }) {
    if (credential?.authType !== "custom_credential") {
      throw new ProviderRequestError(401, "Configure WeChat Pay merchant credentials first.");
    }
    const values = readWechatPayCredential(credential.values);
    const bodyText = body == null ? "" : typeof body === "string" ? body : JSON.stringify(body);
    headers.set("authorization", buildWechatPayAuthorization(values, method, url, bodyText));
    headers.set("accept", "application/json");
    if (body != null) {
      headers.set("content-type", "application/json");
      setBody(bodyText);
    }
  },
});

export const triggers: readonly IntegrationDefinition[] = [paymentNotify];
