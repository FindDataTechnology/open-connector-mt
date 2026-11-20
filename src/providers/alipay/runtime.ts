import type { TransitFileWriter } from "../../core/types.ts";
import type { KeyObject } from "node:crypto";

import { createPublicKey, createSign, createVerify, X509Certificate } from "node:crypto";
import { optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import { assertPublicHttpUrl, readBoundedResponseBytes } from "../../core/request.ts";
import { ProviderRequestError, providerInputError, providerUserAgent } from "../provider-runtime.ts";

const defaultGatewayUrl = "https://openapi.alipay.com/gateway.do";
const signatureAlgorithmName = "RSA2";

export { defaultGatewayUrl, signatureAlgorithmName };

/**
 * Normalized Alipay open platform credential read from a `custom_credential` connection.
 */
export interface AlipayCredential {
  appId: string;
  appPrivateKeyPem: string;
  alipayPublicKey?: string;
  gatewayUrl: string;
}

/**
 * Runtime context handed to every Alipay action handler.
 */
export interface AlipayContext {
  credential: AlipayCredential;
  fetcher: typeof fetch;
  transitFiles?: TransitFileWriter;
  signal?: AbortSignal;
}

interface AlipayGatewayRequestInput {
  method: string;
  bizContent: Record<string, unknown>;
}

/**
 * Read and validate the credential field map stored on a connection. Secret
 * material stays inside the runtime context and is never echoed back.
 */
export function readAlipayCredential(values: Record<string, string>): AlipayCredential {
  const appId = requiredString(values.appId, "appId", invalidCredential);
  const appPrivateKeyPem = requiredString(values.appPrivateKey, "appPrivateKey", invalidCredential);
  if (!appPrivateKeyPem.includes("PRIVATE KEY")) {
    throw new ProviderRequestError(400, "appPrivateKey must be the application private key in PEM format");
  }
  assertRsaPrivateKey(appPrivateKeyPem);
  const alipayPublicKey = optionalString(values.alipayPublicKey);
  const gatewayUrl = optionalString(values.gatewayUrl);
  return {
    appId,
    appPrivateKeyPem,
    alipayPublicKey: alipayPublicKey && alipayPublicKey.length > 0 ? normalizePublicKeyPem(alipayPublicKey) : undefined,
    gatewayUrl: gatewayUrl && gatewayUrl.length > 0 ? resolveGatewayUrl(gatewayUrl) : defaultGatewayUrl,
  };
}

function invalidCredential(message: string): Error {
  return providerInputError(message);
}

function assertRsaPrivateKey(pem: string): void {
  try {
    createPublicKey(pem);
  } catch {
    throw new ProviderRequestError(400, "appPrivateKey is not a readable RSA private key PEM");
  }
}

/**
 * Accept either a bare base64 public key (Alipay's 支付宝公钥 format) or a full
 * PEM key or certificate, and return a PEM the node crypto APIs can read.
 */
export function normalizePublicKeyPem(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes("-----BEGIN")) return trimmed;
  const body = trimmed.replaceAll(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(body)) {
    throw new ProviderRequestError(400, "alipayPublicKey must be base64 or PEM");
  }
  const wrapped = body.replaceAll(/(.{64})/g, "$1\n").trim();
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----`;
}

export function resolveGatewayUrl(value: string): string {
  const url = assertPublicHttpUrl(value, {
    fieldName: "gatewayUrl",
    allowPrivateNetwork: false,
    createError: (message) => new ProviderRequestError(400, message),
  });
  return url.href;
}

function readResponsePublicKey(pem: string): KeyObject {
  const normalized = normalizePublicKeyPem(pem);
  if (normalized.includes("BEGIN CERTIFICATE")) {
    return new X509Certificate(normalized).publicKey;
  }
  return createPublicKey(normalized);
}

/**
 * Build the RSA2 signature of one Alipay parameter map: all non-empty values
 * sorted by key, joined as `k=v` with `&`, signed with the application private key.
 */
export function signAlipayParams(params: Readonly<Record<string, string>>, appPrivateKeyPem: string): string {
  return createSign("RSA-SHA256").update(canonicalAlipayString(params)).sign(appPrivateKeyPem, "base64");
}

/**
 * Verify one RSA2 signature of an Alipay parameter map (async notifications and
 * gateway responses) with the 支付宝公钥.
 */
export function verifyAlipaySignature(input: {
  alipayPublicKeyPem: string;
  params: Readonly<Record<string, string>>;
  signatureBase64: string;
}): boolean {
  let publicKey: KeyObject;
  try {
    publicKey = readResponsePublicKey(input.alipayPublicKeyPem);
  } catch {
    return false;
  }
  return createVerify("RSA-SHA256")
    .update(canonicalAlipayString(input.params))
    .verify(publicKey, input.signatureBase64, "base64");
}

export function canonicalAlipayString(params: Readonly<Record<string, string>>): string {
  return Object.keys(params)
    .filter((key) => key !== "sign" && key !== "sign_type" && params[key] !== "" && params[key] !== undefined)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
}

/**
 * Format a date as the Alipay timestamp `yyyy-MM-dd HH:mm:ss` in GMT+8.
 */
export function formatAlipayTimestamp(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = (value: number) => value.toString().padStart(2, "0");
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  );
}

interface AlipayGatewayResult {
  response: Record<string, unknown>;
  responseText: string;
  responseNode: string;
}

/**
 * Build the complete signed parameter map for one open API request.
 */
export function buildAlipayRequestParams(
  credential: AlipayCredential,
  method: string,
  bizContent: Record<string, unknown>,
  now: Date = new Date(),
): Record<string, string> {
  const params: Record<string, string> = {
    app_id: credential.appId,
    method,
    format: "JSON",
    charset: "utf-8",
    sign_type: signatureAlgorithmName,
    timestamp: formatAlipayTimestamp(now),
    version: "1.0",
    biz_content: JSON.stringify(bizContent),
  };
  params.sign = signAlipayParams(params, credential.appPrivateKeyPem);
  return params;
}

/**
 * Issue one signed form request against the open API gateway and return the parsed response node.
 */
export async function alipayGatewayRequest(
  credential: AlipayCredential,
  fetcher: typeof fetch,
  input: AlipayGatewayRequestInput,
  signal?: AbortSignal,
): Promise<AlipayGatewayResult> {
  const params = buildAlipayRequestParams(credential, input.method, input.bizContent);
  const response = await fetcher(credential.gatewayUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "user-agent": providerUserAgent,
    },
    body: new URLSearchParams(params).toString(),
    signal,
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw mapAlipayHttpError(response.status, responseText);
  }
  return parseAlipayGatewayResponse(responseText, input.method, credential);
}

function responseNodeName(method: string): string {
  return `${method.replaceAll(".", "_")}_response`;
}

function parseAlipayGatewayResponse(
  responseText: string,
  method: string,
  credential: AlipayCredential,
): AlipayGatewayResult {
  const payload = optionalRecord(JSON.parse(responseText));
  if (!payload) {
    throw new ProviderRequestError(502, "Alipay gateway returned a non-object response");
  }
  const errorNode = optionalRecord(payload.error_response);
  const responseNode = responseNodeName(method);
  const response = optionalRecord(payload[responseNode]);
  if (errorNode) {
    throw alipayCodeError(
      optionalString(errorNode.code) ?? "",
      optionalString(errorNode.msg) ?? "Alipay gateway request failed",
      optionalString(errorNode.sub_code),
      optionalString(errorNode.sub_msg),
    );
  }
  if (!response) {
    throw new ProviderRequestError(502, `Alipay gateway response is missing the ${responseNode} node`);
  }
  verifyGatewayResponseSign(responseText, responseNode, payload, credential);
  const code = optionalString(response.code) ?? "";
  if (code !== "10000") {
    throw alipayCodeError(
      code,
      optionalString(response.msg) ?? "Alipay request failed",
      optionalString(response.sub_code),
      optionalString(response.sub_msg),
    );
  }
  return { response, responseText, responseNode };
}

/**
 * Verify the gateway response signature against the raw response text, per the
 * official verification rules: the signed content is the exact serialized
 * response node value (from its first `{` to its last `}`), extracted from the
 * raw text instead of re-serializing the parsed object. Skipped when no
 * 支付宝公钥 is configured.
 */
function verifyGatewayResponseSign(
  responseText: string,
  responseNode: string,
  payload: Record<string, unknown>,
  credential: AlipayCredential,
): void {
  if (!credential.alipayPublicKey) return;
  const signature = optionalString(payload.sign);
  if (!signature) {
    throw new ProviderRequestError(502, "Alipay gateway response is missing the sign field");
  }
  const nodeStart = responseText.indexOf(`"${responseNode}":`);
  const signStart = responseText.lastIndexOf(',"sign"');
  if (nodeStart < 0 || signStart <= nodeStart) {
    throw new ProviderRequestError(502, "Alipay gateway response shape is not verifiable");
  }
  const nodeText = responseText
    .slice(nodeStart + `"${responseNode}":`.length, signStart)
    .replace(/^[^{]*{/g, "{")
    .replace(/\}([^}]*)$/g, "}");
  let verified = false;
  try {
    verified = verifyRawAlipayContent({
      alipayPublicKeyPem: credential.alipayPublicKey,
      content: nodeText,
      signatureBase64: signature,
    });
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new ProviderRequestError(502, "Alipay gateway response signature verification failed");
  }
}

/**
 * Verify one RSA2 signature over a raw string (gateway response nodes) with the 支付宝公钥.
 */
export function verifyRawAlipayContent(input: {
  alipayPublicKeyPem: string;
  content: string;
  signatureBase64: string;
}): boolean {
  const publicKey = readResponsePublicKey(input.alipayPublicKeyPem);
  return createVerify("RSA-SHA256").update(input.content).verify(publicKey, input.signatureBase64, "base64");
}

function alipayCodeError(code: string, message: string, subCode?: string, subMessage?: string): ProviderRequestError {
  const text = [message, subCode, subMessage].filter(Boolean).join(": ");
  if (isAlipayAuthCode(code, subCode)) {
    return new ProviderRequestError(401, text || "Alipay rejected the application credentials");
  }
  if (code === "20000" || code.startsWith("2000")) {
    return new ProviderRequestError(502, text, 502);
  }
  return providerInputError(text);
}

function isAlipayAuthCode(code: string, subCode?: string): boolean {
  if (["40002", "40003", "40005", "40006", "20001"].includes(code)) return true;
  const sub = subCode ?? "";
  return (
    sub.startsWith("isv.invalid-signature") || sub.startsWith("isv.invalid-app-id") || sub.startsWith("aop.invalid")
  );
}

function mapAlipayHttpError(status: number, bodyText: string): ProviderRequestError {
  if (status === 401 || status === 403) {
    return new ProviderRequestError(status, bodyText.trim() || "Alipay gateway rejected the request credentials");
  }
  return new ProviderRequestError(502, bodyText.trim() || `Alipay gateway request failed with HTTP ${status}`, status);
}

/**
 * List the entry names of a ZIP archive by walking its central directory. The
 * bill archive is stored for the consumer; the runtime only reports its shape.
 */
export function zipEntryNames(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let eocd = -1;
  for (let index = bytes.byteLength - 22; index >= Math.max(0, bytes.byteLength - 22 - 65_536); index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("missing end of central directory");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("corrupt central directory");
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    names.push(decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/**
 * Query one trade and return the parsed `alipay_trade_query_response`.
 */
export async function queryAlipayTrade(
  credential: AlipayCredential,
  fetcher: typeof fetch,
  input: { tradeNo?: string; outTradeNo?: string },
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const bizContent: Record<string, unknown> = {};
  if (input.tradeNo) bizContent.trade_no = input.tradeNo;
  if (input.outTradeNo) bizContent.out_trade_no = input.outTradeNo;
  const { response } = await alipayGatewayRequest(
    credential,
    fetcher,
    { method: "alipay.trade.query", bizContent },
    signal,
  );
  return response;
}

/**
 * Request the bill download URL and download the ZIP archive into transit storage.
 */
export async function downloadAlipaySettlementBill(
  credential: AlipayCredential,
  context: Pick<AlipayContext, "fetcher" | "signal">,
  input: { billDate: string; billType: string; fileName?: string },
  transitFiles: TransitFileWriter,
): Promise<Record<string, unknown>> {
  const { response } = await alipayGatewayRequest(
    credential,
    context.fetcher,
    {
      method: "alipay.data.dataservice.bill.downloadurl.query",
      bizContent: { bill_type: input.billType, bill_date: input.billDate },
    },
    context.signal,
  );
  const billDownloadUrl = requiredString(
    response.bill_download_url,
    "bill_download_url",
    (message) => new ProviderRequestError(502, message),
  );
  const url = assertPublicHttpUrl(billDownloadUrl, {
    fieldName: "bill_download_url",
    allowPrivateNetwork: false,
    createError: (message) => new ProviderRequestError(502, message),
  });
  const billResponse = await context.fetcher(url, {
    method: "GET",
    headers: { accept: "application/zip, application/octet-stream", "user-agent": providerUserAgent },
    signal: context.signal,
  });
  if (!billResponse.ok) {
    throw mapAlipayHttpError(billResponse.status, await billResponse.text().catch(() => ""));
  }
  const bytes = await readBoundedResponseBytes(billResponse, {
    maxBytes: transitFiles.maxBytes,
    fieldName: "Alipay bill download",
    createError: (message) => new ProviderRequestError(413, message),
  });
  let entries: string[];
  try {
    entries = zipEntryNames(bytes);
  } catch {
    throw new ProviderRequestError(502, "Alipay bill download is not a readable ZIP archive");
  }
  const name = input.fileName ?? `alipay-bill-${input.billType}-${input.billDate}.zip`;
  const file = await transitFiles.create(new File([Uint8Array.from(bytes)], name, { type: "application/zip" }));
  return {
    billDate: input.billDate,
    billType: input.billType,
    billDownloadUrl,
    name,
    mimeType: "application/zip",
    sizeBytes: bytes.byteLength,
    entries,
    file,
  };
}
