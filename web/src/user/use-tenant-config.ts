import type { TenantConfig } from "./tenant-api";

/**
 * Tenant deployment facts for the console shell (open-connector-mt).
 * Fetches /api/tenant/config once; `undefined` while loading, null when the
 * deployment has no tenant routes (TENANCY=off).
 */
import { useEffect, useState } from "react";
import { tenantApi } from "./tenant-api";

export function useTenantConfig(): TenantConfig | null | undefined {
  const [config, setConfig] = useState<TenantConfig | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    tenantApi
      .config()
      .then((c) => {
        if (!cancelled) setConfig(c);
      })
      .catch(() => {
        if (!cancelled) setConfig(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return config;
}
