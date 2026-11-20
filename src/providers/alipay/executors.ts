import type { CredentialValidators, ProviderExecutors, ProviderProxyExecutor } from "../../core/types.ts";
import type { IntegrationDefinition } from "../../triggers/common/integration.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";
import type { AlipayContext } from "./runtime.ts";

import { optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import {
  defineProviderExecutors,
  defineProviderProxy,
  ProviderRequestError,
  requireCustomCredential,
} from "../provider-runtime.ts";
import {
  alipayGatewayRequest,
  buildAlipayRequestParams,
  downloadAlipaySettlementBill,
  queryAlipayTrade,
  readAlipayCredential,
  resolveGatewayUrl,
} from "./runtime.ts";
import { tradeNotify } from "./trigger-trade-notify.ts";

const service = "alipay";

type AlipayActionHandler = (input: Record<string, unknown>, context: AlipayContext) => Promise<unknown>;

/**
 * Read-only methods the proxy may call on the Alipay gateway. Refund,
 * transfer, and settlement write methods stay unreachable so the whole
 * provider exposes no funds-moving face.
 */
const proxyAllowedMethods = new Set([
  "alipay.trade.query",
  "alipay.trade.fastpay.refund.query",
  "alipay.data.dataservice.bill.downloadurl.query",
]);

export const alipayActionHandlers: ProviderActionHandlers<"alipay", AlipayActionHandler> = {
  async query_trade(input, context) {
    const tradeNo = optionalString(input.tradeNo);
    const outTradeNo = optionalString(input.outTradeNo);
    if (!tradeNo && !outTradeNo) {
      throw new ProviderRequestError(400, "query_trade requires tradeNo or outTradeNo");
    }
    const payload = await queryAlipayTrade(
      context.credential,
      context.fetcher,
      { tradeNo, outTradeNo },
      context.signal,
    );
    return {
      result: payload,
      tradeNo: optionalString(payload.trade_no) ?? null,
      outTradeNo: optionalString(payload.out_trade_no) ?? null,
      tradeStatus: optionalString(payload.trade_status) ?? null,
      totalAmount: optionalString(payload.total_amount) ?? null,
      sendPayDate: optionalString(payload.send_pay_date) ?? null,
    };
  },
  async download_settlement_bill(input, context) {
    if (!context.transitFiles) {
      throw new ProviderRequestError(400, "alipay download_settlement_bill requires local transit file storage");
    }
    return downloadAlipaySettlementBill(
      context.credential,
      context,
      {
        billDate: requiredString(input.billDate, "billDate", (message) => new ProviderRequestError(400, message)),
        billType: optionalString(input.billType) ?? "trade",
        fileName: optionalString(input.fileName),
      },
      context.transitFiles,
    );
  },
};

// The API gateway is credential-configurable (gatewayUrl field), so the DNS
// resolved-address check of the guarded fetch stays enabled for this provider;
// only the URL and redirect guards are unconditional.
export const executors: ProviderExecutors = defineProviderExecutors<AlipayContext>({
  service,
  handlers: alipayActionHandlers,
  async createContext(context, fetcher): Promise<AlipayContext> {
    const credential = await requireCustomCredential(context, service);
    return {
      credential: readAlipayCredential(credential.values),
      fetcher,
      signal: context.signal,
      transitFiles: context.transitFiles,
    };
  },
});

export const credentialValidators: CredentialValidators = {
  async customCredential(input, { fetcher, signal }) {
    const credential = readAlipayCredential(input.values);
    // A signed query of a guaranteed-missing order is the cheapest proof that
    // the application key pair authenticates: the gateway answers with a
    // signed business failure instead of a signature error.
    try {
      await alipayGatewayRequest(
        credential,
        fetcher,
        {
          method: "alipay.trade.query",
          bizContent: { out_trade_no: "__credential_check__" },
        },
        signal,
      );
    } catch (error) {
      if (error instanceof ProviderRequestError) {
        // A signed business failure proves the key pair is accepted.
        if (error.status === 400) return validatorProfile(credential);
        // A validate-phase rejection is a field error on the connect form, not a reconnect prompt.
        if (error.status === 401 || error.status === 403) {
          throw new ProviderRequestError(400, error.message);
        }
      }
      throw error;
    }
    return validatorProfile(credential);
  },
};

function validatorProfile(credential: ReturnType<typeof readAlipayCredential>) {
  return {
    profile: {
      accountId: credential.appId,
      displayName: `Alipay app ${credential.appId}`,
      grantedScopes: [],
    },
    grantedScopes: [],
    metadata: {
      gatewayUrl: credential.gatewayUrl,
      responseSignVerification: credential.alipayPublicKey != null,
    },
  };
}

export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  baseUrl: async (context, proxyService) => {
    const credential = await requireCustomCredential(context, proxyService);
    const values = readAlipayCredential(credential.values);
    return resolveGatewayUrl(values.gatewayUrl);
  },
  auth: { type: "credential_headers", headers: [] },
  customizeRequest({ credential, body, setBody, headers }) {
    if (credential?.authType !== "custom_credential") {
      throw new ProviderRequestError(401, "Configure Alipay open platform credentials first.");
    }
    const values = readAlipayCredential(credential.values);
    const request = optionalRecord(body);
    const method = optionalString(request?.method);
    if (!method || !proxyAllowedMethods.has(method)) {
      throw new ProviderRequestError(400, "endpoint is not supported for this provider");
    }
    const bizContent = optionalRecord(request?.biz_content) ?? {};
    const params = buildAlipayRequestParams(values, method, bizContent);
    headers.set("content-type", "application/x-www-form-urlencoded");
    headers.set("accept", "application/json");
    setBody(new URLSearchParams(params).toString());
  },
});

export const triggers: readonly IntegrationDefinition[] = [tradeNotify];
