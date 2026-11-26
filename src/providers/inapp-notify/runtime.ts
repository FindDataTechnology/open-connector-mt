import type { CredentialValidationResult } from "../../core/types.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";

import { compactObject, optionalInteger, optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import { assertPublicHttpUrl } from "../../core/request.ts";
import {
  providerInputError,
  providerResponseError,
  providerUserAgent,
  ProviderRequestError,
  requiredInputString,
  requiredResponseRecord,
  runProviderRequest,
} from "../provider-runtime.ts";

type InappNotifyPhase = "validate" | "execute";
type InappNotifyActionHandler = (input: Record<string, unknown>, context: InappNotifyActionContext) => Promise<unknown>;

interface InappNotifyRequestInput {
  path: string;
  method: "GET" | "POST";
  context: InappNotifyActionContext;
  phase: InappNotifyPhase;
  body?: Record<string, unknown>;
}

export interface InappNotifyActionContext {
  baseUrl: string;
  accountToken: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

export const inappNotifyActionHandlers: ProviderActionHandlers<"inapp-notify", InappNotifyActionHandler> = {
  async send_broadcast(input, context) {
    const payload = await requestInappNotifyJson({
      path: "/api/broadcast",
      method: "POST",
      context,
      phase: "execute",
      body: buildBroadcastBody(input),
    });
    return { broadcasts: [normalizeBroadcast(payload)] };
  },
};

export async function validateInappNotifyCredential(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const context = createInappNotifyContext(values, fetcher, signal);
  const identity = requiredResponseRecord(
    await requestInappNotifyJson({ path: "/api/auth/me", method: "GET", context, phase: "validate" }),
    "gateway identity",
  );
  if (identity.authenticated !== true) {
    throw new ProviderRequestError(400, "accountToken did not authenticate an account");
  }
  const email = optionalString(identity.email);
  const host = new URL(context.baseUrl).host;

  return {
    profile: {
      accountId: email ? `inapp-notify:${email}` : `inapp-notify:${host}`,
      displayName: email ? `${email} @ ${host}` : `In-App Notify ${host}`,
      grantedScopes: [],
    },
    grantedScopes: [],
    metadata: compactObject({
      baseUrl: context.baseUrl,
      email,
      isAdmin: typeof identity.isAdmin === "boolean" ? identity.isAdmin : undefined,
    }),
  };
}

export function createInappNotifyContext(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): InappNotifyActionContext {
  return {
    baseUrl: normalizeInappNotifyBaseUrl(values.gatewayUrl),
    accountToken: requiredInputString(values.accountToken, "accountToken"),
    fetcher,
    signal,
  };
}

/**
 * Validate a gateway HTTP URL, strip query/hash, and drop a trailing slash.
 * The base is credential-configured, so cloud-metadata, loopback, and private
 * targets are refused before any request leaves the process.
 */
export function normalizeInappNotifyBaseUrl(value: unknown): string {
  const raw = requiredInputString(value, "gatewayUrl");
  const url = assertPublicHttpUrl(raw, { fieldName: "gatewayUrl", createError: providerInputError });
  if (url.username || url.password) throw providerInputError("gatewayUrl must not include credentials");
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/u, "");
}

async function requestInappNotifyJson(input: InappNotifyRequestInput): Promise<unknown> {
  const url = new URL(`${input.context.baseUrl}${input.path}`);

  return runProviderRequest({ signal: input.context.signal, label: "platform gateway" }, async (signal) => {
    const response = await input.context.fetcher(url, {
      method: input.method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.context.accountToken}`,
        "user-agent": providerUserAgent,
        ...(input.body ? { "content-type": "application/json" } : {}),
      },
      body: input.body ? JSON.stringify(input.body) : undefined,
      signal,
    });
    const text = await response.text().catch(() => "");
    const payload = parsePayload(text, response.ok);
    if (!response.ok) {
      throw createInappNotifyError(response.status, payload, input.phase);
    }
    return payload;
  });
}

function parsePayload(text: string, ok: boolean): unknown {
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (ok) throw providerResponseError("platform gateway returned malformed JSON");
    return text;
  }
}

function createInappNotifyError(status: number, payload: unknown, phase: InappNotifyPhase): ProviderRequestError {
  const message = extractErrorMessage(payload, status);
  // 401 stays 401 so the runtime surfaces AUTH_FAILED (an expired account token);
  // during validation it means the token itself is bad, so it becomes a 400.
  if (status === 401 || status === 403) {
    return phase === "validate" ? providerInputError(message) : new ProviderRequestError(status, message);
  }
  if (status === 429) {
    return new ProviderRequestError(429, message);
  }
  if ([400, 404, 409, 422].includes(status)) {
    return providerInputError(message);
  }
  return new ProviderRequestError(status || 500, message);
}

// Upstream error shape: {"error": "message", "code"?: "..."}.
function extractErrorMessage(payload: unknown, status: number): string {
  const body = optionalRecord(payload);
  return (
    optionalString(body?.error) ??
    optionalString(body?.message) ??
    `platform gateway request failed with HTTP ${status}`
  );
}

function buildBroadcastBody(input: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    audience: requireAudience(input.audience),
    body: requiredInputString(input.body, "body"),
  };
  const title = optionalString(input.title);
  if (title !== undefined) body.title = title;
  const action = optionalRecord(input.action);
  if (action) body.action = action;
  const wake = optionalString(input.wake);
  if (wake !== undefined) body.wake = wake;
  return body;
}

function requireAudience(value: unknown): Record<string, unknown> {
  const audience = optionalRecord(value);
  if (!audience) {
    throw providerInputError("audience must be an object");
  }
  return audience;
}

function normalizeBroadcast(payload: unknown): Record<string, unknown> {
  const record = requiredResponseRecord(payload, "platform gateway broadcast");
  const im = optionalRecord(record.im);
  return compactObject({
    id: requiredString(record.id, "id", providerResponseError),
    seq: optionalInteger(record.seq),
    audience: optionalRecord(record.audience),
    audienceLabel: optionalString(record.audienceLabel),
    hitCount: optionalInteger(record.hitCount),
    okCount: optionalInteger(record.okCount),
    failCount: optionalInteger(record.failCount),
    wake: optionalString(record.wake),
    im: im ? compactObject({ sent: optionalInteger(im.sent), failed: optionalInteger(im.failed) }) : undefined,
  });
}
