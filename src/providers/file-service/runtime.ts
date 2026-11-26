import type { CredentialValidationResult } from "../../core/types.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";

import { compactObject, optionalInteger, optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import { assertPublicHttpUrl, encodePathSegment } from "../../core/request.ts";
import {
  providerInputError,
  providerResponseError,
  providerUserAgent,
  ProviderRequestError,
  requiredInputString,
  requiredResponseRecord,
  runProviderRequest,
} from "../provider-runtime.ts";

type FileServicePhase = "validate" | "execute";
type FileServiceActionHandler = (input: Record<string, unknown>, context: FileServiceActionContext) => Promise<unknown>;

interface FileServiceRequestInput {
  path: string;
  method: "GET" | "POST";
  context: FileServiceActionContext;
  phase: FileServicePhase;
  query?: Record<string, string | undefined>;
  body?: Record<string, unknown>;
}

export interface FileServiceActionContext {
  baseUrl: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

export const fileServiceActionHandlers: ProviderActionHandlers<"file-service", FileServiceActionHandler> = {
  async create_upload_url(input, context) {
    const payload = await requestFileServiceJson({
      path: "/files/upload-url",
      method: "POST",
      context,
      phase: "execute",
      body: buildUploadBody(input),
    });
    return { assets: [normalizeUploadGrant(payload)] };
  },

  async confirm_upload(input, context) {
    const payload = await requestFileServiceJson({
      path: `/files/${encodeFileId(input.file_id)}/confirm`,
      method: "POST",
      context,
      phase: "execute",
      query: { owner: requiredInputString(input.owner, "owner") },
    });
    return { assets: [normalizeAsset(payload)] };
  },

  async get_download_url(input, context) {
    const query: Record<string, string | undefined> = { owner: requiredInputString(input.owner, "owner") };
    const ttl = optionalInteger(input.ttl);
    if (ttl !== undefined) {
      query.ttl = String(ttl);
    }
    const payload = await requestFileServiceJson({
      path: `/files/${encodeFileId(input.file_id)}/download-url`,
      method: "GET",
      context,
      phase: "execute",
      query,
    });
    return { downloads: [normalizeDownload(payload)] };
  },

  async list_files(input, context) {
    const payload = requiredResponseRecord(
      await requestFileServiceJson({
        path: "/files",
        method: "GET",
        context,
        phase: "execute",
        query: buildListQuery(input),
      }),
      "fd-file-service file list",
    );
    if (payload.items !== undefined && !Array.isArray(payload.items)) {
      throw providerResponseError("fd-file-service items is not an array");
    }
    return {
      files: ((payload.items ?? []) as unknown[]).map(normalizeAsset),
      pageInfo: compactObject({
        count: optionalInteger(payload.count),
        total: optionalInteger(payload.total),
        limit: optionalInteger(payload.limit),
        offset: optionalInteger(payload.offset),
        hasMore: typeof payload.has_more === "boolean" ? payload.has_more : undefined,
      }),
    };
  },
};

export async function validateFileServiceCredential(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const context = createFileServiceContext(values, fetcher, signal);
  await requestFileServiceJson({ path: "/health", method: "GET", context, phase: "validate" });
  const host = new URL(context.baseUrl).host;

  return {
    profile: { accountId: `file-service:${host}`, displayName: `File Service ${host}` },
    grantedScopes: [],
    metadata: { baseUrl: context.baseUrl },
  };
}

export function createFileServiceContext(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): FileServiceActionContext {
  return { baseUrl: normalizeFileServiceBaseUrl(values.baseUrl), fetcher, signal };
}

/**
 * Validate a fd-file-service HTTP URL, strip query/hash, and drop a trailing slash.
 * The base is credential-configured, so cloud-metadata, loopback, and private
 * targets are refused before any request leaves the process.
 */
export function normalizeFileServiceBaseUrl(value: unknown): string {
  const raw = requiredInputString(value, "baseUrl");
  const url = assertPublicHttpUrl(raw, { fieldName: "baseUrl", createError: providerInputError });
  if (url.username || url.password) throw providerInputError("baseUrl must not include credentials");
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/u, "");
}

async function requestFileServiceJson(input: FileServiceRequestInput): Promise<unknown> {
  const url = new URL(`${input.context.baseUrl}${input.path}`);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }

  return runProviderRequest({ signal: input.context.signal, label: "fd-file-service" }, async (signal) => {
    const response = await input.context.fetcher(url, {
      method: input.method,
      headers: {
        accept: "application/json",
        "user-agent": providerUserAgent,
        ...(input.body ? { "content-type": "application/json" } : {}),
      },
      body: input.body ? JSON.stringify(input.body) : undefined,
      signal,
    });
    const text = await response.text().catch(() => "");
    const payload = parsePayload(text, response.ok);
    if (!response.ok) {
      throw createFileServiceError(response.status, payload, input.phase);
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
    if (ok) throw providerResponseError("fd-file-service returned malformed JSON");
    return text;
  }
}

function createFileServiceError(status: number, payload: unknown, phase: FileServicePhase): ProviderRequestError {
  const message = extractErrorMessage(payload, status);
  if (phase === "validate" && [400, 401, 403, 404].includes(status)) {
    return providerInputError(message);
  }
  if ([400, 404, 409, 422].includes(status)) {
    return providerInputError(message);
  }
  if (status === 429) {
    return new ProviderRequestError(429, message);
  }
  return new ProviderRequestError(status || 500, message);
}

// Upstream error shape: {"error": {"code", "message", ...}}.
function extractErrorMessage(payload: unknown, status: number): string {
  const error = optionalRecord(optionalRecord(payload)?.error);
  return (
    optionalString(error?.message) ??
    optionalString(error?.code) ??
    `fd-file-service request failed with HTTP ${status}`
  );
}

function buildUploadBody(input: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    owner: requiredInputString(input.owner, "owner"),
    size: requiredInputInteger(input.size),
    sha256: requiredInputString(input.sha256, "sha256"),
  };
  const mime = optionalString(input.mime);
  if (mime !== undefined) body.mime = mime;
  const filename = optionalString(input.filename);
  if (filename !== undefined) body.filename = filename;
  if (typeof input.use_post_policy === "boolean") body.use_post_policy = input.use_post_policy;
  return body;
}

function buildListQuery(input: Record<string, unknown>): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = { owner: requiredInputString(input.owner, "owner") };
  for (const key of ["mime", "mime_prefix", "created_after", "created_before"] as const) {
    const value = optionalString(input[key]);
    if (value !== undefined) query[key] = value;
  }
  const limit = optionalInteger(input.limit);
  if (limit !== undefined) query.limit = String(limit);
  const offset = optionalInteger(input.offset);
  if (offset !== undefined) query.offset = String(offset);
  return query;
}

function normalizeUploadGrant(payload: unknown): Record<string, unknown> {
  const grant = requiredResponseRecord(payload, "fd-file-service upload grant");
  return compactObject({
    id: requiredString(grant.file_id, "file_id", providerResponseError),
    upload_url: requiredString(grant.upload_url, "upload_url", providerResponseError),
    method: requiredString(grant.method, "method", providerResponseError),
    fields: optionalRecord(grant.fields) ?? null,
    storage_key: optionalString(grant.storage_key),
    expires_in: optionalInteger(grant.expires_in),
    dedup: grant.dedup === true,
  });
}

function normalizeAsset(value: unknown): Record<string, unknown> {
  const asset = requiredResponseRecord(value, "fd-file-service file asset");
  return {
    id: requiredString(asset.file_id, "file_id", providerResponseError),
    owner: optionalString(asset.owner),
    sha256: optionalString(asset.sha256),
    size: optionalInteger(asset.size),
    mime: optionalString(asset.mime),
    filename: optionalString(asset.filename) ?? null,
    status: optionalString(asset.status),
    created_at: optionalString(asset.created_at),
    confirmed_at: optionalString(asset.confirmed_at) ?? null,
  };
}

function normalizeDownload(payload: unknown): Record<string, unknown> {
  const access = requiredResponseRecord(payload, "fd-file-service download grant");
  return compactObject({
    id: requiredString(access.file_id, "file_id", providerResponseError),
    download_url: requiredString(access.url, "url", providerResponseError),
    method: optionalString(access.method),
    expires_in: optionalInteger(access.expires_in),
    expires_at: optionalString(access.expires_at),
    content_type: optionalString(access.content_type),
    size: optionalInteger(access.size),
  });
}

function encodeFileId(value: unknown): string {
  const fileId = requiredInputString(value, "file_id");
  if (fileId.includes("/")) {
    throw providerInputError("file_id must not contain slashes");
  }
  return encodePathSegment(fileId);
}

function requiredInputInteger(value: unknown): number {
  const integer = optionalInteger(value);
  if (integer === undefined) {
    throw providerInputError("size must be an integer");
  }
  return integer;
}
