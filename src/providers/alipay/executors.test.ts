import type { ExecutionContext, ResolvedCredential, TransitFileStore } from "../../core/types.ts";

import { createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDefaultGuardedFetchDnsLookup } from "../../core/guarded-fetch.ts";
import { executors } from "./executors.ts";
import {
  canonicalAlipayString,
  formatAlipayTimestamp,
  signAlipayParams,
  verifyAlipaySignature,
  verifyRawAlipayContent,
} from "./runtime.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

const credential: Extract<ResolvedCredential, { authType: "custom_credential" }> = {
  authType: "custom_credential",
  values: {
    appId: "2021000000000000",
    appPrivateKey: privateKeyPem,
    alipayPublicKey: publicKeyPem,
  },
  profile: { accountId: "2021000000000000", displayName: "Alipay app 2021000000000000", grantedScopes: [] },
  metadata: {},
};

interface CapturedRequest {
  url: URL;
  headers: Record<string, string>;
  body: URLSearchParams;
}

beforeEach(() => {
  setDefaultGuardedFetchDnsLookup(null);
});

afterEach(() => {
  setDefaultGuardedFetchDnsLookup(undefined);
  vi.unstubAllGlobals();
});

describe("alipay query_trade", () => {
  it("posts a signed form request and verifies the gateway response signature", async () => {
    const responseNode = {
      code: "10000",
      msg: "Success",
      trade_no: "2024110122001400001234",
      out_trade_no: "order-1",
      trade_status: "TRADE_SUCCESS",
      total_amount: "12.34",
    };
    const responseText = gatewayResponse("alipay_trade_query_response", responseNode);
    const requests = stubResponses([responseText]);

    const captured = await execute("alipay.query_trade", { outTradeNo: "order-1" });

    expect(captured).toMatchObject({
      ok: true,
      output: {
        tradeNo: "2024110122001400001234",
        outTradeNo: "order-1",
        tradeStatus: "TRADE_SUCCESS",
        totalAmount: "12.34",
      },
    });
    expect((captured.output as Record<string, unknown>).result).toMatchObject(responseNode);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.href).toBe("https://openapi.alipay.com/gateway.do");
    expect(requests[0]?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const params = requests[0]!.body;
    expect(params.get("method")).toBe("alipay.trade.query");
    expect(params.get("app_id")).toBe("2021000000000000");
    expect(params.get("sign_type")).toBe("RSA2");
    expect(params.get("biz_content")).toBe(JSON.stringify({ out_trade_no: "order-1" }));
    assertRequestSignature(params);
  });

  it("rejects a request without either identifier before any network call", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const captured = await execute("alipay.query_trade", {});

    expect(captured).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps a business failure to invalid_input with the sub_code", async () => {
    stubResponses([
      gatewayResponse("alipay_trade_query_response", {
        code: "40004",
        msg: "Business Failed",
        sub_code: "ACQ.TRADE_NOT_EXIST",
        sub_msg: "交易不存在",
      }),
    ]);

    const captured = await execute("alipay.query_trade", { tradeNo: "2024110122001400001234" });

    expect(captured).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: "Business Failed: ACQ.TRADE_NOT_EXIST: 交易不存在" },
    });
  });

  it("maps a signature rejection to authorization_failed", async () => {
    stubResponses([
      gatewayResponse("error_response", { code: "40002", msg: "Illegal Signature", sub_code: "isv.invalid-signature" }),
    ]);

    const captured = await execute("alipay.query_trade", { outTradeNo: "order-2" });

    expect(captured).toMatchObject({ ok: false, error: { code: "authorization_failed" } });
  });

  it("fails closed when the gateway response signature does not verify", () => {
    const responseNode = { code: "10000", msg: "Success" };
    const signed = gatewayResponse("alipay_trade_query_response", responseNode);
    const forged = signed.replace(/,"sign":"[^"]+"}$/, ',"sign":"AAAA"}');

    const captured = executeWithResponses(forged);

    return captured.then((result) => {
      expect(result).toMatchObject({
        ok: false,
        error: { code: "provider_error", message: "Alipay gateway response signature verification failed" },
      });
    });
  });
});

describe("alipay download_settlement_bill", () => {
  it("requests the download URL and stores the ZIP archive in transit storage", async () => {
    const archive = buildZip({ "2024-11-01.csv": Buffer.from("hdr1,hdr2\nv1,v2\n") });
    const requests = stubResponses([
      gatewayResponse("alipay_data_dataservice_bill_downloadurl_query_response", {
        code: "10000",
        msg: "Success",
        bill_download_url: "http://dwbillcenter.alipay.com/downloadBillFile.zip?token=abc",
      }),
      new Response(new Uint8Array(archive), { headers: { "content-type": "application/zip" } }),
    ]);
    const { store, create } = createTransitFileStore(1024 * 1024);

    const captured = await execute(
      "alipay.download_settlement_bill",
      { billDate: "2024-11-01", billType: "trade" },
      store,
    );

    expect(captured).toMatchObject({
      ok: true,
      output: {
        billDate: "2024-11-01",
        billType: "trade",
        mimeType: "application/zip",
        entries: ["2024-11-01.csv"],
        name: "alipay-bill-trade-2024-11-01.zip",
        file: { fileId: "transit-file-1" },
      },
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body.get("method")).toBe("alipay.data.dataservice.bill.downloadurl.query");
    assertRequestSignature(requests[0]!.body);
    expect(requests[1]?.url.hostname).toBe("dwbillcenter.alipay.com");
    expect(create).toHaveBeenCalledOnce();
  });

  it("rejects private or metadata download targets", async () => {
    stubResponses([
      gatewayResponse("alipay_data_dataservice_bill_downloadurl_query_response", {
        code: "10000",
        msg: "Success",
        bill_download_url: "http://169.254.169.254/latest/meta-data/",
      }),
    ]);
    const { store } = createTransitFileStore(1024 * 1024);

    const captured = await execute("alipay.download_settlement_bill", { billDate: "2024-11-01" }, store);

    expect(captured).toMatchObject({ ok: false, error: { code: "provider_error" } });
  });
});

describe("alipay credential validation", () => {
  it("accepts credentials the gateway signed a business failure for", async () => {
    stubResponses([
      gatewayResponse("alipay_trade_query_response", {
        code: "40004",
        msg: "Business Failed",
        sub_code: "ACQ.TRADE_NOT_EXIST",
        sub_msg: "交易不存在",
      }),
    ]);

    const { credentialValidators } = await import("./executors.ts");
    const result = await credentialValidators.customCredential?.(
      { values: credential.values },
      { fetcher: globalThis.fetch as typeof fetch },
    );

    expect(result?.profile).toMatchObject({ accountId: "2021000000000000" });
  });

  it("turns a validate-phase signature rejection into a field error", async () => {
    stubResponses([
      gatewayResponse("error_response", { code: "40002", msg: "Illegal Signature", sub_code: "isv.invalid-signature" }),
    ]);

    const { credentialValidators } = await import("./executors.ts");
    const promise = credentialValidators.customCredential?.(
      { values: { ...credential.values, appPrivateKey: privateKeyPem } },
      { fetcher: globalThis.fetch as typeof fetch },
    );
    await expect(promise).rejects.toMatchObject({ status: 400 });
  });
});

describe("alipay request signing", () => {
  it("signs the sorted canonical string and omits empty values", () => {
    const params = { app_id: "2021000000000000", method: "alipay.trade.query", empty: "", charset: "utf-8" };
    const signature = signAlipayParams(params, privateKeyPem);
    const canonical = canonicalAlipayString(params);
    expect(canonical).toBe("app_id=2021000000000000&charset=utf-8&method=alipay.trade.query");
    expect(createVerify("RSA-SHA256").update(canonical).verify(publicKeyPem, signature, "base64")).toBe(true);
  });

  it("rejects a signature computed over different fields", () => {
    const signature = signAlipayParams({ a: "1" }, privateKeyPem);
    expect(
      verifyAlipaySignature({ alipayPublicKeyPem: publicKeyPem, params: { a: "2" }, signatureBase64: signature }),
    ).toBe(false);
    expect(
      verifyAlipaySignature({ alipayPublicKeyPem: publicKeyPem, params: { a: "1" }, signatureBase64: signature }),
    ).toBe(true);
  });

  it("verifies a raw response node payload the way the official SDK does", () => {
    const nodeText = JSON.stringify({ code: "10000", msg: "Success" });
    const signature = createSign("RSA-SHA256").update(nodeText).sign(privateKeyPem, "base64");
    expect(
      verifyRawAlipayContent({ alipayPublicKeyPem: publicKeyPem, content: nodeText, signatureBase64: signature }),
    ).toBe(true);
    expect(
      verifyRawAlipayContent({ alipayPublicKeyPem: publicKeyPem, content: nodeText, signatureBase64: "AAAA" }),
    ).toBe(false);
  });
});

describe("alipay timestamps", () => {
  it("formats GMT+8 timestamps", () => {
    expect(formatAlipayTimestamp(new Date(Date.UTC(2024, 10, 1, 15, 30, 5)))).toBe("2024-11-01 23:30:05");
    expect(formatAlipayTimestamp(new Date(Date.UTC(2024, 0, 1, 0, 0, 0)))).toBe("2024-01-01 08:00:00");
  });
});

/**
 * Build a gateway response the way the gateway does, signing the raw response
 * node with the test key pair standing in for the Alipay public key.
 */
function gatewayResponse(nodeName: string, node: Record<string, unknown>): string {
  const nodeText = JSON.stringify(node);
  const sign = createSign("RSA-SHA256").update(nodeText).sign(privateKeyPem, "base64");
  return `{"${nodeName}":${nodeText},"sign":"${sign}"}`;
}

function assertRequestSignature(params: URLSearchParams): void {
  const fields: Record<string, string> = {};
  for (const [key, value] of params.entries()) fields[key] = value;
  const sign = fields.sign;
  expect(sign).toBeTruthy();
  delete fields.sign;
  expect(createVerify("RSA-SHA256").update(canonicalAlipayString(fields)).verify(publicKeyPem, sign!, "base64")).toBe(
    true,
  );
  expect(params.get("sign_type")).toBe("RSA2");
}

/** Build a minimal STORE-method ZIP archive, readable by node:zlib unzipSync. */
function buildZip(entries: Record<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, content);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(content.length, 20);
    directory.writeUInt32LE(content.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBytes);
    offset += local.length + nameBytes.length + content.length;
  }
  const centralDirectory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralDirectory, end]);
}

function crc32(content: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

type StubbedResponse = string | Response;

function stubResponses(responses: StubbedResponse[]): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push({
      url: new URL(request.url),
      headers: Object.fromEntries(request.headers.entries()),
      body: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
    });
    const response = responses.shift();
    if (!response) {
      throw new Error(`Unexpected Alipay request to ${request.url}`);
    }
    return typeof response === "string"
      ? new Response(response, { headers: { "content-type": "application/json" } })
      : (response as Response);
  });
  return requests;
}

function createTransitFileStore(maxBytes: number): {
  store: TransitFileStore;
  create: ReturnType<typeof vi.fn<TransitFileStore["create"]>>;
} {
  const create = vi.fn<TransitFileStore["create"]>(async (file) => ({
    fileId: "transit-file-1",
    downloadUrl: "http://localhost/api/files/transit-file-1",
    sizeBytes: file.size,
    name: file.name,
    mimeType: file.type,
  }));
  return {
    create,
    store: {
      maxBytes,
      create,
      async read() {
        throw new Error("read is not expected in this test");
      },
      async delete() {
        return false;
      },
    },
  };
}

async function execute(
  action: "alipay.query_trade" | "alipay.download_settlement_bill",
  input: Record<string, unknown>,
  transitFiles?: TransitFileStore,
) {
  const context: ExecutionContext = {
    getCredential: async (service) => {
      expect(service).toBe("alipay");
      return credential;
    },
  };
  if (transitFiles) {
    context.transitFiles = transitFiles;
  }
  return executors[action]!(input, context);
}

function executeWithResponses(
  ...responses: (string | Response)[]
): Promise<{ ok: boolean; output?: unknown; error?: { code?: string; message?: string } }> {
  stubResponses(responses);
  return execute("alipay.query_trade", { outTradeNo: "order-1" });
}
