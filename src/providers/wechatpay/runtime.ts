import type { TransitFileWriter } from "../../core/types.ts";
import type { KeyObject } from "node:crypto";

import { Buffer } from "node:buffer";
import { createPublicKey, createSign, createVerify, X509Certificate } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import { readBoundedResponseBytes } from "../../core/request.ts";
import {
  ProviderRequestError,
  providerInputError,
  providerUserAgent,
  requiredResponseRecord,
} from "../provider-runtime.ts";

const apiBaseUrl = "https://api.mch.weixin.qq.com";
const apiHost = "api.mch.weixin.qq.com";
const signatureAlgorithm = "WECHATPAY2-SHA256-RSA2048";
/** Callback signature timestamps outside this window are rejected as replays. */
const notifyTimestampToleranceSeconds = 300;

export { apiBaseUrl, apiHost, notifyTimestampToleranceSeconds, signatureAlgorithm };

/**
 * Normalized WeChat Pay merchant credential read from a `custom_credential` connection.
 */
export interface WechatPayCredential {
  mchid: string;
  appId?: string;
  privateKeyPem: string;
  certificateSerialNo: string;
  apiv3Key: string;
  platformCertificate?: string;
}

/**
 * Runtime context handed to every WeChat Pay action handler.
 */
export interface WechatPayContext {
  credential: WechatPayCredential;
  fetcher: typeof fetch;
  transitFiles?: TransitFileWriter;
  signal?: AbortSignal;
}

interface WechatPayRequestInput {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}

/**
 * Read and validate the credential field map stored on a connection. Secret
 * material stays inside the runtime context and is never echoed back.
 */
export function readWechatPayCredential(values: Record<string, string>): WechatPayCredential {
  const mchid = requiredString(values.mchid, "mchid", invalidCredential);
  const privateKeyPem = requiredString(
    values.merchantApiCertificatePrivateKey,
    "merchantApiCertificatePrivateKey",
    invalidCredential,
  );
  const certificateSerialNo = requiredString(
    values.merchantCertificateSerialNo,
    "merchantCertificateSerialNo",
    invalidCredential,
  );
  const apiv3Key = requiredString(values.apiv3Key, "apiv3Key", invalidCredential);
  if (apiv3Key.length !== 32) {
    throw new ProviderRequestError(400, "apiv3Key must be the 32-character WeChat Pay APIv3 key");
  }
  if (!privateKeyPem.includes("PRIVATE KEY")) {
    throw new ProviderRequestError(400, "merchantApiCertificatePrivateKey must be the PEM of apiclient_key.pem");
  }
  assertRsaPrivateKey(privateKeyPem);
  const platformCertificate = optionalString(values.platformCertificate);
  if (platformCertificate != null && platformCertificate.length > 0 && !platformCertificate.includes("CERTIFICATE")) {
    throw new ProviderRequestError(
      400,
      "platformCertificate must be the WeChat Pay platform certificate in PEM format",
    );
  }
  const appId = optionalString(values.appId);
  return {
    mchid,
    appId: appId && appId.length > 0 ? appId : undefined,
    privateKeyPem,
    certificateSerialNo,
    apiv3Key,
    platformCertificate: platformCertificate && platformCertificate.length > 0 ? platformCertificate : undefined,
  };
}

function invalidCredential(message: string): Error {
  return providerInputError(message);
}

function assertRsaPrivateKey(pem: string): void {
  try {
    createPublicKey(pem);
  } catch {
    throw new ProviderRequestError(400, "merchantApiCertificatePrivateKey is not a readable RSA private key PEM");
  }
}

function buildSignatureMessage(method: string, url: URL, timestamp: string, nonce: string, bodyText: string): string {
  return [method, `${url.pathname}${url.search}`, timestamp, nonce, bodyText].join("\n");
}

function signRsaSha256Base64(privateKeyPem: string, message: string): string {
  return createSign("RSA-SHA256").update(message).sign(privateKeyPem, "base64");
}

function nonce32(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function unixSeconds(date: Date): string {
  return Math.floor(date.getTime() / 1000).toString();
}

/**
 * Build the APIv3 `Authorization` header for one request, signing
 * `METHOD\npath?query\ntimestamp\nnonce\nbody\n` with the merchant private key.
 */
export function buildWechatPayAuthorization(
  credential: WechatPayCredential,
  method: string,
  url: URL,
  bodyText: string,
  now: Date = new Date(),
): string {
  const timestamp = unixSeconds(now);
  const nonce = nonce32();
  const signature = signRsaSha256Base64(
    credential.privateKeyPem,
    buildSignatureMessage(method, url, timestamp, nonce, bodyText),
  );
  const parts = [
    `mchid="${credential.mchid}"`,
    `nonce_str="${nonce}"`,
    `signature="${signature}"`,
    `timestamp="${timestamp}"`,
    `serial_no="${credential.certificateSerialNo}"`,
  ];
  return `${signatureAlgorithm} ${parts.join(",")}`;
}

function wechatPayUrl(path: string, query?: Record<string, string>): URL {
  const url = new URL(`${apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

async function readWechatPayErrorMessage(response: Response): Promise<string> {
  try {
    const payload = optionalRecord(await response.json());
    const code = optionalString(payload?.code);
    const message = optionalString(payload?.message);
    if (code || message) {
      return [code, message].filter(Boolean).join(": ") || "WeChat Pay request failed";
    }
  } catch {
    // WeChat Pay can return an empty or HTML body for edge errors.
  }
  const text = await response.text().catch(() => "");
  return text.trim() || `WeChat Pay request failed with status ${response.status}`;
}

function mapWechatPayError(status: number, message: string): ProviderRequestError {
  if (status === 401 || status === 403) {
    return new ProviderRequestError(status, message || "WeChat Pay merchant credentials are invalid");
  }
  if (status === 400 || status === 404) {
    return providerInputError(message);
  }
  if (status === 429) {
    return new ProviderRequestError(429, message || "WeChat Pay rate limit exceeded");
  }
  return new ProviderRequestError(502, message, status);
}

/**
 * Issue one signed JSON request against the merchant APIv3 and return the parsed payload.
 */
export async function wechatPayJsonRequest(
  credential: WechatPayCredential,
  fetcher: typeof fetch,
  input: WechatPayRequestInput,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const bodyText = input.body == null ? "" : JSON.stringify(input.body);
  const url = wechatPayUrl(input.path, input.query);
  const response = await fetcher(url, {
    method: input.method,
    headers: {
      accept: "application/json",
      authorization: buildWechatPayAuthorization(credential, input.method, url, bodyText),
      "content-type": "application/json",
      "user-agent": providerUserAgent,
    },
    body: input.body == null ? undefined : bodyText,
    signal,
  });
  if (!response.ok) {
    throw mapWechatPayError(response.status, await readWechatPayErrorMessage(response));
  }
  return requiredResponseRecord(await response.json(), "WeChat Pay API response");
}

/**
 * Extract the public key from a WeChat Pay platform certificate PEM (X.509)
 * or a bare public key PEM.
 */
export function readNotifyPublicKey(pem: string): KeyObject {
  if (pem.includes("BEGIN CERTIFICATE")) {
    return new X509Certificate(pem).publicKey;
  }
  return createPublicKey(pem);
}

/**
 * Verify one WeChat Pay APIv3 callback signature:
 * RSA-SHA256 over `timestamp\nnonce\nbody\n` with the platform certificate's public key.
 */
export function verifyWechatPayNotifySignature(input: {
  platformCertificate: string;
  timestamp: string;
  nonce: string;
  signatureBase64: string;
  bodyText: string;
}): boolean {
  let publicKey: KeyObject;
  try {
    publicKey = readNotifyPublicKey(input.platformCertificate);
  } catch {
    return false;
  }
  const message = [input.timestamp, input.nonce, input.bodyText].join("\n");
  return createVerify("RSA-SHA256").update(message).verify(publicKey, input.signatureBase64, "base64");
}

/**
 * True when the callback timestamp is within the replay tolerance of `now`.
 */
export function isFreshNotifyTimestamp(timestamp: string, now: Date): boolean {
  const value = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(value)) return false;
  return Math.abs(now.getTime() / 1000 - value) <= notifyTimestampToleranceSeconds;
}

/**
 * Download one settlement day's trade bill and store the decompressed CSV in transit storage.
 */
export async function downloadWechatPayBill(
  credential: WechatPayCredential,
  context: Pick<WechatPayContext, "fetcher" | "signal">,
  input: { billDate: string; billType: string; fileName?: string },
  transitFiles: NonNullable<WechatPayContext["transitFiles"]>,
): Promise<Record<string, unknown>> {
  const applied = await wechatPayJsonRequest(
    credential,
    context.fetcher,
    {
      method: "GET",
      path: "/v3/bill/tradebill",
      query: { bill_date: input.billDate, bill_type: input.billType, tar_type: "GZIP" },
    },
    context.signal,
  );
  const downloadUrl = requiredString(
    applied.download_url,
    "download_url",
    (message) => new ProviderRequestError(502, message),
  );
  const hashType = optionalString(applied.hash_type);
  const hashValue = optionalString(applied.hash_value);

  const url = new URL(downloadUrl);
  if (url.protocol !== "https:" || url.hostname !== apiHost) {
    throw new ProviderRequestError(502, "WeChat Pay bill download_url must stay on the merchant API host");
  }
  const response = await context.fetcher(url, {
    method: "GET",
    headers: {
      accept: "application/gzip, application/json",
      authorization: buildWechatPayAuthorization(credential, "GET", url, ""),
      "user-agent": providerUserAgent,
    },
    signal: context.signal,
  });
  if (!response.ok) {
    throw mapWechatPayError(response.status, await readWechatPayErrorMessage(response));
  }
  const compressed = await readBoundedResponseBytes(response, {
    maxBytes: transitFiles.maxBytes,
    fieldName: "WeChat Pay bill download",
    createError: (message) => new ProviderRequestError(413, message),
  });
  let content: Buffer;
  try {
    content = gunzipSync(compressed);
  } catch {
    throw new ProviderRequestError(502, "WeChat Pay bill download is not a readable GZIP payload");
  }
  const name = input.fileName ?? `wechatpay-tradebill-${input.billType.toLowerCase()}-${input.billDate}.csv`;
  const file = await transitFiles.create(new File([new Uint8Array(content)], name, { type: "text/csv" }));
  return {
    billDate: input.billDate,
    billType: input.billType,
    hashType: hashType ?? null,
    hashValue: hashValue ?? null,
    name,
    mimeType: "text/csv",
    sizeBytes: content.byteLength,
    file,
  };
}
