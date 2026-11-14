// Catalog read surface (open-connector-mt) — `/api/catalog/*`.
//
// Why this is not under /api/tenant/* or /v1/*:
//
//   /api/tenant/*  answers "can MY connection honour this?", so it needs a
//                  signed-in identity and must stay that way.
//   /v1/*          is the runtime plane: reading there also means being able to
//                  POST /v1/actions/:id (execute), which is far more authority
//                  than a market service needs to read a catalog.
//   /api/*         (admin) can mint PATs and read across tenants.
//
// A pack market needs one thing: the catalog facts. So it gets exactly that, on
// its own prefix, behind its own switch, with its own credential — rather than a
// wider credential plus an informal promise to only read.
//
// What this surface must never return: connections, tenants, identities, PATs,
// run records, OAuth configuration, credentials. Everything it answers is
// derivable from the catalog alone, which is also why the answer cannot differ
// per caller.

import type { CatalogStore } from "../catalog-store.ts";
import type { CatalogReadConfig } from "./catalog-read-config.ts";
import type { Context, Hono } from "hono";

import { timingSafeEqual } from "node:crypto";
import { jsonError } from "./api/http-utils.ts";
import { catalogProviderSummary, coverageOf, parseCoverageOperations } from "./catalog-coverage.ts";

export interface CatalogRoutesOptions {
  mode: CatalogReadConfig["mode"];
  /** Required in `service` mode; validated at boot, never optional here. */
  token?: string;
  catalog: CatalogStore;
}

/** Constant-time bearer comparison; length mismatch short-circuits (it leaks only length). */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBearer(context: Context): string | null {
  const header = context.req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * The mode gate.
 *
 * Returns a response when the request must stop, or undefined when the handler
 * may continue. 401 (not 404) for a missing/wrong credential: "gated" and "not
 * implemented" are the two answers operators confuse, and this surface exists in
 * the second case only when the switch is off.
 */
function gate(context: Context, options: CatalogRoutesOptions): Response | undefined {
  if (options.mode === "public") return undefined;
  if (options.mode !== "service" || !options.token) {
    // Unreachable when the deployment booted through readCatalogReadConfig
    // (it throws for service-without-token); fail closed if a caller assembled
    // the options by hand.
    return jsonError(context, 401, "unauthorized", "This catalog surface is not configured.");
  }
  const presented = readBearer(context);
  if (!presented || !tokenMatches(presented, options.token)) {
    return jsonError(context, 401, "unauthorized", "A catalog read token is required.");
  }
  return undefined;
}

export function registerCatalogRoutes(app: Hono, options: CatalogRoutesOptions): void {
  const { catalog } = options;

  app.get("/api/catalog/providers", (context) => {
    const denied = gate(context, options);
    if (denied) return denied;
    return context.json({ providers: catalog.providers.map(catalogProviderSummary) });
  });

  app.get("/api/catalog/providers/:service", (context) => {
    const denied = gate(context, options);
    if (denied) return denied;
    const service = context.req.param("service");
    const provider = catalog.providers.find((row) => row.service === service);
    if (!provider) return jsonError(context, 404, "unknown_provider", `Unknown provider: ${service}`);
    return context.json(catalogProviderSummary(provider));
  });

  app.get("/api/catalog/coverage", (context) => {
    const denied = gate(context, options);
    if (denied) return denied;
    const providerId = context.req.query("provider")?.trim();
    if (!providerId) return jsonError(context, 400, "invalid_input", "provider is required.");
    const operations = parseCoverageOperations(context.req.query("operations"));
    if (!operations) {
      return jsonError(
        context,
        400,
        "invalid_input",
        "operations must be a comma-separated subset of: read,write,destructive.",
      );
    }
    const report = coverageOf(catalog, providerId, operations);
    // Unknown provider is 404 rather than an all-zero report: "no such system"
    // and "that system has no actions of this class" have different repairs.
    if (!report) return jsonError(context, 404, "unknown_provider", `Unknown provider: ${providerId}`);
    return context.json(report);
  });

  // Catalog facts only: who owns this id and whether it can run here. The policy
  // answer ("may THIS token run it") stays on /api/tenant/scope-explain — mixing
  // the two is how "the catalog lacks it" and "this deployment forbids it" get
  // confused on the consumer side.
  app.get("/api/catalog/actions/:actionId", (context) => {
    const denied = gate(context, options);
    if (denied) return denied;
    const actionId = context.req.param("actionId");
    const action = catalog.actionsById.get(actionId);
    if (!action) return jsonError(context, 404, "unknown_action", `Unknown action: ${actionId}`);
    return context.json({
      actionId: action.id,
      provider: action.service,
      operationType: action.operationType,
      executable: action.execution.locallyExecutable,
    });
  });

  // Read-only by construction: the prefix answers 405 to every write verb rather
  // than relying on a missing handler to produce a 404. `jsonError` is typed to
  // the runtime envelope's status union (which has no 405), so this one states
  // the status directly while keeping the same `{error:{code,message}}` shape.
  for (const method of ["post", "put", "patch", "delete"] as const) {
    app[method]("/api/catalog/*", (context) =>
      context.json(
        { error: { code: "method_not_allowed", message: "The catalog read surface is read-only." } },
        405,
      ),
    );
  }
}
