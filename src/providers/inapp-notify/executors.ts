import type {
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
  ProviderProxyExecutor,
} from "../../core/types.ts";
import type { InappNotifyActionContext } from "./runtime.ts";

import { defineProviderExecutors, defineProviderProxy, requireCustomCredential } from "../provider-runtime.ts";
import {
  createInappNotifyContext,
  inappNotifyActionHandlers,
  normalizeInappNotifyBaseUrl,
  validateInappNotifyCredential,
} from "./runtime.ts";

const service = "inapp-notify";

export const executors: ProviderExecutors = defineProviderExecutors<InappNotifyActionContext>({
  service,
  handlers: inappNotifyActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<InappNotifyActionContext> {
    const credential = await requireCustomCredential(context, service);
    return createInappNotifyContext(credential.values, fetcher, context.signal);
  },
  fallbackMessage: "platform gateway request failed",
});

// Proxy keeps the default public-only DNS guard: the base URL comes from the
// credential, so the resolved-address check is the SSRF defense, not overhead.
export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  async baseUrl(context) {
    const credential = await requireCustomCredential(context, service);
    return normalizeInappNotifyBaseUrl(credential.values.gatewayUrl);
  },
  auth: { type: "custom_credential_header", field: "accountToken", name: "authorization", prefix: "Bearer " },
  customizeRequest({ headers }) {
    if (!headers.has("accept")) headers.set("accept", "application/json");
  },
});

export const credentialValidators: CredentialValidators = {
  customCredential(input, { fetcher, signal }) {
    return validateInappNotifyCredential(input.values, fetcher, signal);
  },
};
