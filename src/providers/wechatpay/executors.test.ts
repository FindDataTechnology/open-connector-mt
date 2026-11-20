import type { ExecutionContext, ResolvedCredential, TransitFileStore } from "../../core/types.ts";

import { createVerify, generateKeyPairSync } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDefaultGuardedFetchDnsLookup } from "../../core/guarded-fetch.ts";
import { executors } from "./executors.ts";
import { buildWechatPayAuthorization } from "./runtime.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

const credential: Extract<ResolvedCredential, { authType: "custom_credential" }> = {
  authType: "custom_credential",
  values: {
    mchid: "1900000000",
    appId: "wx8888888888888888",
    merchantApiCertificatePrivateKey: privateKeyPem,
    merchantCertificateSerialNo: "SERIAL-NO-1",
    apiv3Key: "0123456789abcdef0123456789abcdef",
  },
  profile: { accountId: "1900000000", displayName: "WeChat Pay merchant 1900000000", grantedScopes: [] },
  metadata: {},
};

interface CapturedRequest {
  url: URL;
  authorization: string | null;
  headers: Record<string, string>;
  body: string | undefined;
}

beforeEach(() => {
  setDefaultGuardedFetchDnsLookup(null);
});

afterEach(() => {
  setDefaultGuardedFetchDnsLookup(undefined);
  vi.unstubAllGlobals();
});

describe("wechatpay query_transaction", () => {
  it("signs the request and returns the mapped transaction", async () => {
    const transaction = {
      out_trade_no: "order-1",
      transaction_id: "4200001234202411010000000001",
      trade_state: "SUCCESS",
      amount: { total: 100, currency: "CNY" },
      success_time: "2024-11-01T10:00:00+08:00",
    };
    const requests = stubResponses([jsonResponse(transaction)]);
    const captured = await execute("wechatpay.query_transaction", { transactionId: transaction.transaction_id });

    expect(captured).toMatchObject({
      ok: true,
      output: {
        transaction,
        transactionId: transaction.transaction_id,
        outTradeNo: "order-1",
        tradeState: "SUCCESS",
        amountTotal: 100,
        successTime: transaction.success_time,
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.hostname).toBe("api.mch.weixin.qq.com");
    expect(requests[0]?.url.pathname).toBe(`/v3/pay/transactions/id/${transaction.transaction_id}`);
    expect(requests[0]?.url.searchParams.get("mchid")).toBe("1900000000");
    assertSignatureHeaders(requests[0]!, "GET", `${requests[0]!.url.pathname}${requests[0]!.url.search}`, "");
  });

  it("signs the out-trade-no variant", async () => {
    const requests = stubResponses([jsonResponse({ out_trade_no: "order-2", trade_state: "CLOSED" })]);
    const captured = await execute("wechatpay.query_transaction", { outTradeNo: "order-2" });

    expect(captured).toMatchObject({ ok: true, output: { tradeState: "CLOSED" } });
    expect(requests[0]?.url.pathname).toBe("/v3/pay/transactions/out-trade-no/order-2");
  });

  it("rejects a request without either identifier before any network call", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const captured = await execute("wechatpay.query_transaction", {});

    expect(captured).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("wechatpay download_bill", () => {
  it("applies for the bill, downloads the GZIP payload and stores decompressed CSV", async () => {
    const csv = "header,rows\n`交易时间,公众账号ID`,x\n";
    const requests = stubResponses([
      jsonResponse({
        download_url: "https://api.mch.weixin.qq.com/v3/billdownload/file?token=abc",
        hash_type: "SHA1",
        hash_value: "abc123",
      }),
      new Response(gzipSync(Buffer.from(csv)), { headers: { "content-type": "application/gzip" } }),
    ]);
    const { store, create } = createTransitFileStore(1024 * 1024);

    const captured = await execute("wechatpay.download_bill", { billDate: "2024-11-01", billType: "ALL" }, store);

    expect(captured).toMatchObject({
      ok: true,
      output: {
        billDate: "2024-11-01",
        billType: "ALL",
        hashType: "SHA1",
        hashValue: "abc123",
        mimeType: "text/csv",
        sizeBytes: Buffer.byteLength(csv),
        name: "wechatpay-tradebill-all-2024-11-01.csv",
        file: { fileId: "transit-file-1", name: "wechatpay-tradebill-all-2024-11-01.csv" },
      },
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url.pathname).toBe("/v3/bill/tradebill");
    expect(requests[0]?.url.searchParams.get("bill_date")).toBe("2024-11-01");
    expect(requests[0]?.url.searchParams.get("tar_type")).toBe("GZIP");
    assertSignatureHeaders(requests[0]!, "GET", `${requests[0]!.url.pathname}${requests[0]!.url.search}`, "");
    expect(requests[0]?.headers["content-type"]).toBe("application/json");
    expect(requests[1]?.url.hostname).toBe("api.mch.weixin.qq.com");
    assertSignatureHeaders(requests[1]!, "GET", `${requests[1]!.url.pathname}${requests[1]!.url.search}`, "");
    expect(create).toHaveBeenCalledOnce();
  });

  it("rejects a download_url that leaves the merchant API host", async () => {
    stubResponses([jsonResponse({ download_url: "https://evil.example/file?token=abc" })]);
    const { store } = createTransitFileStore(1024 * 1024);

    const captured = await execute("wechatpay.download_bill", { billDate: "2024-11-01" }, store);

    expect(captured).toMatchObject({
      ok: false,
      error: { code: "provider_error", message: "WeChat Pay bill download_url must stay on the merchant API host" },
    });
  });

  it("requires transit file storage", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const captured = await execute("wechatpay.download_bill", { billDate: "2024-11-01" });

    expect(captured).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: "wechatpay download_bill requires local transit file storage" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("wechatpay error mapping", () => {
  it("maps upstream 401 to authorization_failed and surfaces the provider message", async () => {
    stubResponses([new Response(JSON.stringify({ code: "SIGN_ERROR", message: "签名错误" }), { status: 401 })]);

    const captured = await execute("wechatpay.query_transaction", { outTradeNo: "order-3" });

    expect(captured).toMatchObject({
      ok: false,
      error: { code: "authorization_failed", message: "SIGN_ERROR: 签名错误", details: { status: 401 } },
    });
  });

  it("maps business 404 to invalid_input", async () => {
    stubResponses([
      new Response(JSON.stringify({ code: "ORDER_NOT_EXIST", message: "order not exists" }), { status: 404 }),
    ]);

    const captured = await execute("wechatpay.query_transaction", { outTradeNo: "order-4" });

    expect(captured).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: "ORDER_NOT_EXIST: order not exists", details: { status: 400 } },
    });
  });
});

describe("wechatpay credential validation", () => {
  it("validates with the certificate list endpoint and returns the merchant profile", async () => {
    const requests = stubResponses([jsonResponse({ data: [] })]);
    const fetcher = globalThis.fetch as typeof fetch;

    const { credentialValidators } = await import("./executors.ts");
    const result = await credentialValidators.customCredential?.({ values: credential.values }, { fetcher });

    expect(result?.profile).toMatchObject({ accountId: "1900000000", displayName: "WeChat Pay merchant 1900000000" });
    expect(requests[0]?.url.pathname).toBe("/v3/certificates");
    assertSignatureHeaders(requests[0]!, "GET", "/v3/certificates", "");
  });

  it("turns a validate-phase rejection into a field error", async () => {
    stubResponses([new Response(JSON.stringify({ code: "SIGN_ERROR" }), { status: 401 })]);

    const { credentialValidators } = await import("./executors.ts");
    const promise = credentialValidators.customCredential?.(
      { values: credential.values },
      { fetcher: globalThis.fetch as typeof fetch },
    );
    await expect(promise).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a wrong APIv3 key length before any network call", () => {
    expect(() =>
      import("./runtime.ts").then((m) => m.readWechatPayCredential({ ...credential.values, apiv3Key: "short" })),
    ).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("wechatpay authorization header", () => {
  it("produces a signature that verifies against the merchant public key", () => {
    const url = new URL("https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/order-5?mchid=1900000000");
    const authorization = buildWechatPayAuthorization(
      {
        mchid: "1900000000",
        privateKeyPem,
        certificateSerialNo: "SERIAL-NO-1",
        apiv3Key: "0123456789abcdef0123456789abcdef",
      },
      "GET",
      url,
      "",
      new Date(1730419200000),
    );

    expect(authorization).toContain('mchid="1900000000"');
    expect(authorization).toContain('serial_no="SERIAL-NO-1"');
    expect(authorization).toContain('timestamp="1730419200"');
    const signature = /signature="([^"]+)"/.exec(authorization)?.[1] ?? "";
    const nonce = /nonce_str="([^"]+)"/.exec(authorization)?.[1] ?? "";
    const message = ["GET", `${url.pathname}${url.search}`, "1730419200", nonce, ""].join("\n");
    expect(createVerify("RSA-SHA256").update(message).verify(publicKeyPem, signature, "base64")).toBe(true);
  });

  it("produces different signatures for different request targets", () => {
    const credentialInput = {
      mchid: "1900000000",
      privateKeyPem,
      certificateSerialNo: "SERIAL-NO-1",
      apiv3Key: "0123456789abcdef0123456789abcdef",
    };
    const now = new Date(1730419200000);
    const first = buildWechatPayAuthorization(
      credentialInput,
      "GET",
      new URL("https://api.mch.weixin.qq.com/v3/certificates"),
      "",
      now,
    );
    const second = buildWechatPayAuthorization(
      credentialInput,
      "GET",
      new URL("https://api.mch.weixin.qq.com/v3/bill/tradebill"),
      "",
      now,
    );
    expect(first).not.toBe(second);
  });
});

function assertSignatureHeaders(request: CapturedRequest, method: string, pathWithQuery: string, body: string): void {
  const authorization = request.authorization ?? "";
  expect(authorization.startsWith("WECHATPAY2-SHA256-RSA2048 ")).toBe(true);
  const timestamp = /timestamp="(\d+)"/.exec(authorization)?.[1] ?? "";
  const nonce = /nonce_str="([^"]+)"/.exec(authorization)?.[1] ?? "";
  const signature = /signature="([^"]+)"/.exec(authorization)?.[1] ?? "";
  const message = [method, pathWithQuery, timestamp, nonce, body].join("\n");
  expect(createVerify("RSA-SHA256").update(message).verify(publicKeyPem, signature, "base64")).toBe(true);
  expect(JSON.stringify(request.headers)).not.toContain(privateKeyPem);
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
}

function stubResponses(responses: Response[]): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push({
      url: new URL(request.url),
      authorization: request.headers.get("authorization"),
      headers: Object.fromEntries(request.headers.entries()),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const response = responses.shift();
    if (!response) {
      throw new Error(`Unexpected WeChat Pay request to ${request.url}`);
    }
    return response;
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
  action: "wechatpay.query_transaction" | "wechatpay.download_bill",
  input: Record<string, unknown>,
  transitFiles?: TransitFileStore,
) {
  const context: ExecutionContext = {
    getCredential: async (service) => {
      expect(service).toBe("wechatpay");
      return credential;
    },
  };
  if (transitFiles) {
    context.transitFiles = transitFiles;
  }
  return executors[action]!(input, context);
}
