import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDefaultGuardedFetchDnsLookup } from "../../core/guarded-fetch.ts";
import { executors, credentialValidators } from "./executors.ts";

const credential: Extract<ResolvedCredential, { authType: "custom_credential" }> = {
  authType: "custom_credential",
  values: {
    baseUrl: "https://erp.example.com/",
    dataCenterId: "dc-1",
    username: "integration-user",
    applicationId: "app-id-1",
    applicationSecret: "secret-app-value",
    localeId: "2052",
  },
  profile: {
    accountId: "https://erp.example.com/:dc-1:integration-user",
    displayName: "integration-user · erp.example.com",
    grantedScopes: [],
  },
  metadata: {},
};

interface CapturedRequest {
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
}

function loginResponse(sessionId = "session-abc") {
  return new Response(JSON.stringify({ LoginResultType: 1, KDSVCSessionId: sessionId }), {
    headers: { "content-type": "application/json" },
  });
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
}

function stubResponses(responses: Response[]): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push({
      url: new URL(request.url),
      headers: Object.fromEntries(request.headers.entries()),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected Kingdee request to ${request.url}`);
    return response;
  });
  return requests;
}

async function execute(
  action:
    | "kingdee.query_records"
    | "kingdee.get_record"
    | "kingdee.query_report"
    | "kingdee.save_record"
    | "kingdee.audit_records",
  input: Record<string, unknown>,
) {
  const context: ExecutionContext = {
    getCredential: async (service) => {
      expect(service).toBe("kingdee");
      return credential;
    },
  };
  return executors[action]!(input, context);
}

beforeEach(() => {
  setDefaultGuardedFetchDnsLookup(null);
});

afterEach(() => {
  setDefaultGuardedFetchDnsLookup(undefined);
  vi.unstubAllGlobals();
});

describe("kingdee login", () => {
  it("posts LoginByAppSecret and carries the session id on the action call", async () => {
    const requests = stubResponses([
      loginResponse("session-xyz"),
      jsonResponse([
        ["CUST-1", "杭州仓配"],
        ["CUST-2", "宁波仓配"],
      ]),
    ]);

    const captured = await execute("kingdee.query_records", {
      formId: "BD_Customer",
      data: { FieldKeys: "FNumber,FName", FilterString: "", StartRow: 0 },
    });

    expect(captured).toMatchObject({
      ok: true,
      output: { fieldKeys: ["FNumber", "FName"] },
    });
    expect(requests).toHaveLength(2);

    expect(requests[0]?.url.pathname).toBe(
      "/Kingdee.BOS.WebApi.ServicesStub.AuthService.LoginByAppSecret.common.kdsvc",
    );
    expect(JSON.parse(requests[0]!.body!)).toEqual({
      parameters: ["dc-1", "integration-user", "app-id-1", "secret-app-value", 2052],
    });

    expect(requests[1]?.url.pathname).toBe(
      "/Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.ExecuteBillQuery.common.kdsvc",
    );
    expect(requests[1]?.headers["kdservice-sessionid"]).toBe("session-xyz");
    expect(JSON.parse(JSON.parse(requests[1]!.body!).data)).toMatchObject({
      FormId: "BD_Customer",
      FieldKeys: "FNumber,FName",
    });
  });

  it("accepts IsSuccessByAPI as the login verdict", async () => {
    const requests = stubResponses([
      jsonResponse({ IsSuccessByAPI: true, KDSVCSessionId: "from-body" }),
      jsonResponse([]),
    ]);

    await execute("kingdee.query_records", {
      formId: "BD_Customer",
      data: { FieldKeys: "FNumber" },
    });

    expect(requests[1]?.headers["kdservice-sessionid"]).toBe("from-body");
  });

  it("fails closed when login reports no success and redacts the application secret", async () => {
    stubResponses([jsonResponse({ LoginResultType: 0, Message: "bad secret-app-value" })]);

    const captured = await execute("kingdee.query_records", {
      formId: "BD_Customer",
      data: { FieldKeys: "FNumber" },
    });

    expect(captured).toMatchObject({ ok: false, error: { code: "provider_error" } });
    expect(JSON.stringify(captured)).not.toContain("secret-app-value");
  });

  it("rejects a login that returns no usable session id", async () => {
    stubResponses([jsonResponse({ LoginResultType: 1 })]);

    const captured = await execute("kingdee.query_records", {
      formId: "BD_Customer",
      data: { FieldKeys: "FNumber" },
    });

    expect(captured).toMatchObject({ ok: false, error: { code: "provider_error" } });
    expect(JSON.stringify(captured)).toContain("no usable session ID");
  });
});

describe("kingdee query_records", () => {
  it("returns rows and field keys that line up with the response columns", async () => {
    stubResponses([
      loginResponse(),
      jsonResponse([
        ["CUST-1", "杭州仓配", 1200],
        ["CUST-2", "宁波仓配", 800],
      ]),
    ]);

    const captured = await execute("kingdee.query_records", {
      formId: "BD_Customer",
      data: { FieldKeys: "FNumber , FName ,FDebit", FilterString: "FNumber='CUST-1'" },
    });

    expect(captured).toMatchObject({
      ok: true,
      output: {
        rows: [
          ["CUST-1", "杭州仓配", 1200],
          ["CUST-2", "宁波仓配", 800],
        ],
        fieldKeys: ["FNumber", "FName", "FDebit"],
      },
    });
  });

  it("surfaces a business failure nested inside a query payload", async () => {
    stubResponses([
      loginResponse(),
      jsonResponse([{ IsSuccess: false, Errors: [{ Message: "FNumber does not exist" }] }]),
    ]);

    const captured = await execute("kingdee.query_records", {
      formId: "BD_Customer",
      data: { FieldKeys: "FNumber" },
    });

    expect(captured).toMatchObject({ ok: false, error: { code: "provider_error" } });
    expect(JSON.stringify(captured)).toContain("FNumber does not exist");
  });

  it("rejects a non-array query payload instead of treating it as zero rows", async () => {
    stubResponses([loginResponse(), jsonResponse({ Result: [] })]);

    const captured = await execute("kingdee.query_records", {
      formId: "BD_Customer",
      data: { FieldKeys: "FNumber" },
    });

    expect(captured).toMatchObject({ ok: false, error: { code: "provider_error" } });
    expect(JSON.stringify(captured)).toContain("did not return rows");
  });

  it("rejects a missing formId before any network call", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const captured = await execute("kingdee.query_records", { data: { FieldKeys: "FNumber" } });

    expect(captured).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("kingdee write actions", () => {
  it("reports partial success when some entities save and some fail", async () => {
    stubResponses([
      loginResponse(),
      jsonResponse({
        Result: {
          ResponseStatus: {
            IsSuccess: false,
            SuccessEntitys: [{ Id: 100001, Number: "CUST-100001" }],
            Errors: [{ Message: "FName is required for row 2" }],
          },
        },
      }),
    ]);

    const captured = await execute("kingdee.save_record", {
      formId: "BD_Customer",
      data: { FNumber: "CUST-100001", FName: "新客户" },
    });

    expect(captured).toMatchObject({
      ok: true,
      output: {
        success: false,
        partialSuccess: true,
        successfulEntities: [{ Id: 100001, Number: "CUST-100001" }],
      },
    });
    expect(JSON.stringify(captured)).toContain("FName is required for row 2");
  });

  it("fails when an audit request names no records", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const captured = await execute("kingdee.audit_records", {
      formId: "BD_Customer",
      data: { Numbers: [] },
    });

    expect(captured).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails the whole call when every entity failed", async () => {
    stubResponses([
      loginResponse(),
      jsonResponse({
        Result: {
          ResponseStatus: {
            IsSuccess: false,
            Errors: [{ Message: "the customer is locked" }],
          },
        },
      }),
    ]);

    const captured = await execute("kingdee.audit_records", {
      formId: "BD_Customer",
      data: { Numbers: ["CUST-1"] },
    });

    expect(captured).toMatchObject({ ok: false, error: { code: "provider_error" } });
    expect(JSON.stringify(captured)).toContain("the customer is locked");
  });
});

describe("kingdee get_record", () => {
  it("returns the record and its result envelope", async () => {
    stubResponses([
      loginResponse(),
      jsonResponse({
        Result: {
          ResponseStatus: { IsSuccess: true },
          Result: { FNumber: "CUST-1", FName: "杭州仓配" },
        },
      }),
    ]);

    const captured = await execute("kingdee.get_record", {
      formId: "BD_Customer",
      data: { Number: "CUST-1" },
    });

    expect(captured).toMatchObject({
      ok: true,
      output: { record: { FNumber: "CUST-1", FName: "杭州仓配" } },
    });
  });

  it("requires an Id or Number before calling out", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const captured = await execute("kingdee.get_record", { formId: "BD_Customer", data: {} });

    expect(captured).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("kingdee query_report", () => {
  it("passes the report result through", async () => {
    stubResponses([
      loginResponse(),
      jsonResponse({
        Result: { ResponseStatus: { IsSuccess: true }, Result: { rows: [{ FAmount: 100 }] } },
      }),
    ]);

    const captured = await execute("kingdee.query_report", {
      formId: "AP_AGING",
      data: { FNumber: "S001" },
    });

    expect(captured).toMatchObject({ ok: true });
  });
});

describe("kingdee credential validation", () => {
  it("logs in and returns an account profile built from the instance coordinates", async () => {
    stubResponses([loginResponse()]);

    const result = await credentialValidators.customCredential!(credential, {
      fetcher: globalThis.fetch,
      signal: undefined,
    });

    expect(result!.profile).toMatchObject({
      accountId: "https://erp.example.com/:dc-1:integration-user",
    });
    expect(result!.profile?.displayName).toContain("erp.example.com");
  });

  it("rejects a documentation site as the base URL", async () => {
    await expect(
      credentialValidators.customCredential!(
        {
          ...credential,
          values: { ...credential.values, baseUrl: "https://open.kingdee.com/" },
        },
        { fetcher: globalThis.fetch, signal: undefined },
      ),
    ).rejects.toThrow(/enterprise instance/);
  });

  it("rejects a plain-HTTP base URL", async () => {
    await expect(
      credentialValidators.customCredential!(
        {
          ...credential,
          values: { ...credential.values, baseUrl: "http://erp.example.com/" },
        },
        { fetcher: globalThis.fetch, signal: undefined },
      ),
    ).rejects.toThrow(/HTTPS/);
  });
});
