// Catalog coverage — the single owner of "does this provider cover these
// operation classes?".
//
// Two very different consumers ask that question and must get the same answer:
//
//   /api/tenant/catalog-coverage   a signed-in user, about their own bindings
//                                  (the tenant plane)
//   /api/catalog/coverage          a service (the pack market) about whether the
//                                  catalog can honour a declared surface at all
//                                  (the catalog plane; no tenant involved)
//
// The calculation is small enough that a second copy is tempting and that is
// exactly the failure this module prevents: if the two drift by one line (say
// one counts `destructive` and the other does not), a pack reports "supported"
// on the settings page and "unsupported" in the market, and no test goes red
// unless the two are compared on purpose.
//
// Deliberately excluded: any policy question. `scope-explain` answers "may this
// token run this action" and belongs to the runtime plane; this module answers
// only "does the catalog have an executable action of that class".

import type { CatalogStore, RuntimeProviderDefinition } from "../catalog-store.ts";

/** The operation classes a binding can declare. `destructive` is addressable too. */
export const COVERAGE_OPERATION_TYPES = ["read", "write", "destructive"] as const;

export type CoverageOperationType = (typeof COVERAGE_OPERATION_TYPES)[number];

export interface CoverageOperationRow {
  operation: CoverageOperationType;
  /** Executable actions of this class exist, so a binding can be honoured. */
  covered: boolean;
  /** Actions of this class in the catalog, executable or not. */
  actionCount: number;
  /** Actions of this class this deployment can actually run. */
  executableActionCount: number;
}

export interface CoverageReport {
  provider: string;
  operations: CoverageOperationRow[];
  /** Classes with no executable action — the declared surface cannot be met. */
  gaps: CoverageOperationType[];
}

/**
 * Parse a `read,write` style query value into a validated class list.
 *
 * Returns undefined for anything that is not a non-empty subset: a typo must be
 * a 400 at every entry point, not a silently empty answer.
 */
export function parseCoverageOperations(raw: string | undefined | null): CoverageOperationType[] | undefined {
  const requested = (raw ?? "read,write")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const valid = requested.filter((value): value is CoverageOperationType =>
    (COVERAGE_OPERATION_TYPES as readonly string[]).includes(value),
  );
  if (valid.length !== requested.length || valid.length === 0) return undefined;
  return [...new Set(valid)];
}

/**
 * The coverage answer for one provider, or undefined when the catalog has no
 * such provider.
 *
 * Undefined rather than an all-zero report on purpose: "we have never heard of
 * this system" and "we know it and it has no actions of that class" lead to
 * different repairs, and collapsing them hides a typo behind a capability gap.
 */
export function coverageOf(
  catalog: Pick<CatalogStore, "providers">,
  providerId: string,
  operations: readonly CoverageOperationType[],
): CoverageReport | undefined {
  const provider = catalog.providers.find((row) => row.service === providerId);
  if (!provider) return undefined;
  const rows = operations.map((operation) => {
    const actions = provider.actions.filter((action) => action.operationType === operation);
    const executableActionCount = actions.filter((action) => action.execution.locallyExecutable).length;
    return {
      operation,
      covered: executableActionCount > 0,
      actionCount: actions.length,
      executableActionCount,
    };
  });
  return {
    provider: provider.service,
    operations: rows,
    gaps: rows.filter((row) => !row.covered).map((row) => row.operation),
  };
}

/** The catalog-plane projection of one provider: metadata only, no credentials. */
export interface CatalogProviderSummary {
  service: string;
  displayName: string;
  categories: readonly string[];
  authTypes: readonly string[];
  actionCount: number;
}

export function catalogProviderSummary(provider: RuntimeProviderDefinition): CatalogProviderSummary {
  return {
    service: provider.service,
    displayName: provider.displayName,
    categories: provider.categories ?? [],
    authTypes: provider.authTypes ?? [],
    actionCount: provider.actions.length,
  };
}
