import type {
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
  ProviderProxyExecutor,
} from "../../core/types.ts";
import type { FileServiceActionContext } from "./runtime.ts";

import { defineProviderExecutors, defineProviderProxy, requireCustomCredential } from "../provider-runtime.ts";
import {
  createFileServiceContext,
  fileServiceActionHandlers,
  normalizeFileServiceBaseUrl,
  validateFileServiceCredential,
} from "./runtime.ts";

const service = "file-service";

export const executors: ProviderExecutors = defineProviderExecutors<FileServiceActionContext>({
  service,
  handlers: fileServiceActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<FileServiceActionContext> {
    const credential = await requireCustomCredential(context, service);
    return createFileServiceContext(credential.values, fetcher, context.signal);
  },
  fallbackMessage: "fd-file-service request failed",
});

// Proxy keeps the default public-only DNS guard: the base URL comes from the
// credential, so the resolved-address check is the SSRF defense, not overhead.
export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  async baseUrl(context) {
    const credential = await requireCustomCredential(context, service);
    return normalizeFileServiceBaseUrl(credential.values.baseUrl);
  },
  auth: { type: "none" },
  customizeRequest({ headers }) {
    if (!headers.has("accept")) headers.set("accept", "application/json");
  },
});

export const credentialValidators: CredentialValidators = {
  customCredential(input, { fetcher, signal }) {
    return validateFileServiceCredential(input.values, fetcher, signal);
  },
};
