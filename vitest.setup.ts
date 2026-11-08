import { setDefaultGuardedFetchDnsLookup } from "./src/core/guarded-fetch.ts";

// Unit tests must never depend on real DNS resolution: disable the module
// default (node:dns) lookup used by guarded provider fetches. Guard-specific
// tests inject their own lookup through createGuardedFetch({ lookup }).
setDefaultGuardedFetchDnsLookup(null);

// open-connector-mt: the server's admin surface now fails closed when no
// OOMOL_CONNECT_ADMIN_TOKEN is configured (it used to answer /api/* to anyone).
// Most suites predate that and drive the admin API without credentials, so the
// suite opts into the same explicit open mode a trusted local deployment uses.
// Tests that assert the fail-closed default override this per case with
// `vi.stubEnv("OOMOL_CONNECT_ALLOW_OPEN_ADMIN", undefined)`.
process.env.OOMOL_CONNECT_ALLOW_OPEN_ADMIN = "1";
