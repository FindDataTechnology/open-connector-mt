import type { TenantConnection, TenantPat, TenantRun, TenantSession } from "./tenant-api";
/**
 * User panel (open-connector-mt): the tenant-facing face of the console —
 * my connections (paste / OAuth / delete, with auth-free virtual sources
 * grouped and collapsed), my PATs (mint with one-time display / revoke,
 * pinned above the connections), and an action test-run. Admin keeps the
 * upstream console; this page is mounted only in TENANCY=oidc mode.
 */
import type { ReactNode } from "react";

import { useTranslate } from "@embra/i18n/react";
import { KeyRound, Loader2, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError } from "../api";
import { Badge, EmptyState, InlineError, StatusDot } from "../shared-ui";
import { tenantApi } from "./tenant-api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type LoadState = "loading" | "ready" | "error";

type ProviderOption = { service: string; displayName: string; authTypes: string[] };

/**
 * Providers a tenant can actually configure. Auth-free-only entries (no api_key,
 * no oauth2) are already available as virtual rows — offering them here would
 * only produce a form with no valid auth type.
 */
export function configurableProviders(providers: ProviderOption[]): ProviderOption[] {
  return providers.filter((p) => p.authTypes.some((type) => type === "api_key" || type === "oauth2"));
}

/** How many matches a rendered picker page shows before it tells you the rest exist. */
export const providerPickerLimit = 50;

export function filterProviders(providers: ProviderOption[], query: string): ProviderOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return providers;
  return providers.filter(
    (p) => p.displayName.toLowerCase().includes(needle) || p.service.toLowerCase().includes(needle),
  );
}

export function UserPage(props: { providers: ProviderOption[] }): ReactNode {
  const [session, setSession] = useState<TenantSession | null>(null);
  const [sessionState, setSessionState] = useState<LoadState>("loading");
  const [connections, setConnections] = useState<TenantConnection[]>([]);
  const [connectionsState, setConnectionsState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);

  const refreshConnections = useCallback(() => {
    setConnectionsState("loading");
    tenantApi
      .connections()
      .then((r) => {
        setConnections(r.connections.filter((c) => c.configured));
        setConnectionsState("ready");
      })
      .catch((e) => {
        setError(e instanceof ApiError ? e.message : String(e));
        setConnectionsState("error");
      });
  }, []);

  useEffect(() => {
    tenantApi
      .session()
      .then((s) => {
        setSession(s);
        setSessionState("ready");
      })
      .catch(() => {
        setSession(null);
        setSessionState("ready");
      });
    refreshConnections();
  }, [refreshConnections]);

  if (sessionState === "loading") {
    return <Centered>{<Loader2 className="spin" size={20} />}</Centered>;
  }
  if (!session) {
    return (
      <Centered>
        <SignInCard />
      </Centered>
    );
  }

  return (
    <UserPanelBody
      session={session}
      providers={props.providers}
      connections={connections}
      connectionsState={connectionsState}
      error={error}
      onChanged={refreshConnections}
    />
  );
}

/** Pre-login hero: brand + one-line purpose + the single sign-in entry. */
export function SignInCard(): ReactNode {
  const t = useTranslate();
  return (
    <div className="user-hero-card">
      <div className="console-brand">{t("userPanel.brand")}</div>
      <p className="user-hero-intro">{t("userPanel.signInIntro")}</p>
      <Button onClick={() => window.location.assign("/api/tenant/oidc/authorize")}>
        <KeyRound size={15} /> {t("tenant.signIn")}
      </Button>
    </div>
  );
}

/** Signed-in layout: PATs first (the only cross-platform output), then connections, then test-run. */
export function UserPanelBody(props: {
  session: TenantSession;
  providers: ProviderOption[];
  connections: TenantConnection[];
  connectionsState: LoadState;
  error: string | null;
  onChanged(): void;
}): ReactNode {
  const t = useTranslate();
  const own = props.connections.filter((c) => !c.virtual);
  const virtual = props.connections.filter((c) => c.virtual);

  return (
    <div className="user-page">
      <header className="user-page-header">
        <div>
          <h1>{t("tenant.title")}</h1>
          <p className="user-page-subtitle">
            {props.session.displayName || props.session.email || props.session.tenantId}
            {" · "}
            {t("tenant.kind." + props.session.kind)}
          </p>
        </div>
        <div className="user-page-actions">
          <Button variant="outline" size="sm" onClick={props.onChanged}>
            <RefreshCw size={15} /> {t("common.refresh")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => tenantApi.logout().then(() => window.location.reload())}>
            {t("tenant.signOut")}
          </Button>
        </div>
      </header>
      {props.error ? <InlineError message={props.error} /> : null}

      <PatsCard />
      <ConnectionsCard
        providers={props.providers}
        own={own}
        virtual={virtual}
        state={props.connectionsState}
        onChanged={props.onChanged}
      />
      <TestRunCard connectionNames={[...new Set(props.connections.map((c) => c.connectionName ?? "default"))]} />
      <RunsCard />
    </div>
  );
}

function ConnectionsCard(props: {
  providers: ProviderOption[];
  own: TenantConnection[];
  virtual: TenantConnection[];
  state: LoadState;
  onChanged: () => void;
}): ReactNode {
  const t = useTranslate();
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [service, setService] = useState("");
  const [authType, setAuthType] = useState("api_key");
  const [connectionName, setConnectionName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");

  const pickable = useMemo(() => configurableProviders(props.providers), [props.providers]);
  const matches = useMemo(() => filterProviders(pickable, pickerQuery), [pickable, pickerQuery]);
  const visibleMatches = matches.slice(0, providerPickerLimit);

  const selectedProvider = pickable.find((p) => p.service === service);
  const supportsOAuth = selectedProvider?.authTypes.includes("oauth2") ?? false;

  const create = async () => {
    if (!service) return;
    setBusy(true);
    setFormError(null);
    try {
      if (authType === "oauth2") {
        const { authorizationUrl } = await tenantApi.startOAuth(service, connectionName || undefined);
        window.location.assign(authorizationUrl);
        return;
      }
      await tenantApi.createConnection({
        service,
        connectionName: connectionName || undefined,
        authType,
        values: authType === "api_key" ? { apiKey } : {},
      });
      setApiKey("");
      setConnectionName("");
      props.onChanged();
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (serviceId: string, name: string) => {
    setBusy(true);
    setFormError(null);
    try {
      await tenantApi.deleteConnection(serviceId, name);
      props.onChanged();
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="user-card">
      <h2>{t("tenant.connections.title")}</h2>
      {props.state === "loading" ? (
        <Loader2 className="spin" size={18} />
      ) : (
        <>
          {props.own.length === 0 ? (
            <EmptyState title={t("tenant.connections.title")} description={t("tenant.connections.empty")} />
          ) : (
            <ul className="user-connection-list">
              {props.own.map((c) => (
                <li key={`${c.service}:${c.connectionName}`}>
                  <StatusDot ok={c.authType !== "oauth2" || c.status !== "reauth_required"} />
                  <span className="user-connection-name">
                    {c.service} / {c.connectionName}
                  </span>
                  <Badge tone={c.authType === "oauth2" && c.status === "reauth_required" ? "warning" : "success"}>
                    {c.authType === "oauth2" && c.status === "reauth_required"
                      ? t("tenant.connections.reauth")
                      : c.authType}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => remove(c.service, c.connectionName ?? "default")}
                  >
                    <Trash2 size={14} /> {t("tenant.connections.delete")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {props.virtual.length > 0 ? (
            <details className="user-noauth-group">
              <summary>
                {t("userPanel.noAuthGroup")}
                <span className="user-noauth-count">{props.virtual.length}</span>
              </summary>
              <ul className="user-connection-list">
                {props.virtual.map((c) => (
                  <li key={`${c.service}:${c.connectionName}`}>
                    <StatusDot ok={c.authType !== "oauth2" || c.status !== "reauth_required"} />
                    <span className="user-connection-name">
                      {c.service} / {c.connectionName}
                    </span>
                    <Badge tone={c.authType === "oauth2" && c.status === "reauth_required" ? "warning" : "success"}>
                      {c.authType === "oauth2" && c.status === "reauth_required"
                        ? t("tenant.connections.reauth")
                        : c.authType}
                    </Badge>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
      {formError ? <InlineError message={formError} /> : null}
      <div className="user-connection-form">
        <div className="user-form-row">
          <Label>{t("tenant.connections.provider")}</Label>
          <Button variant="outline" onClick={() => setPickerOpen(true)}>
            <Search size={14} />
            {selectedProvider ? selectedProvider.displayName : t("tenant.connections.pickProvider")}
          </Button>
          <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
            <DialogContent className="user-provider-picker">
              <DialogHeader>
                <DialogTitle>{t("tenant.connections.pickProvider")}</DialogTitle>
                <DialogDescription>{t("tenant.connections.pickProviderHint")}</DialogDescription>
              </DialogHeader>
              <Input
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                placeholder={t("tenant.connections.searchPlaceholder")}
                aria-label={t("tenant.connections.searchPlaceholder")}
              />
              <p className="user-picker-count" data-testid="provider-match-count">
                {t("tenant.connections.matchCount", { count: matches.length })}
              </p>
              <ul className="user-picker-list" data-testid="provider-picker-list">
                {visibleMatches.map((p) => (
                  <li key={p.service}>
                    <Button
                      variant="ghost"
                      className="user-picker-row"
                      onClick={() => {
                        setService(p.service);
                        setAuthType(p.authTypes.includes("api_key") ? "api_key" : "oauth2");
                        setPickerQuery("");
                        setPickerOpen(false);
                      }}
                    >
                      <span className="user-picker-name">{p.displayName}</span>
                      <span className="user-picker-service">{p.service}</span>
                      {p.authTypes.includes("oauth2") ? (
                        <span className="user-picker-oauth">{t("tenant.connections.oauthCapable")}</span>
                      ) : null}
                    </Button>
                  </li>
                ))}
              </ul>
            </DialogContent>
          </Dialog>
        </div>
        <div className="user-form-row">
          <Label>{t("tenant.connections.authType")}</Label>
          <Select value={authType} onValueChange={setAuthType}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="api_key">API Key</SelectItem>
              {supportsOAuth ? <SelectItem value="oauth2">OAuth</SelectItem> : null}
            </SelectContent>
          </Select>
        </div>
        <div className="user-form-row">
          <Label>{t("tenant.connections.name")}</Label>
          <Input value={connectionName} onChange={(e) => setConnectionName(e.target.value)} placeholder="default" />
        </div>
        {authType === "api_key" ? (
          <div className="user-form-row">
            <Label>API Key</Label>
            <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </div>
        ) : null}
        <Button disabled={busy || !service} onClick={create}>
          {busy ? <Loader2 className="spin" size={14} /> : <Plus size={14} />} {t("tenant.connections.add")}
        </Button>
      </div>
    </section>
  );
}

function PatsCard(): ReactNode {
  const t = useTranslate();
  const [pats, setPats] = useState<TenantPat[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [name, setName] = useState("");
  const [minted, setMinted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    tenantApi
      .pats()
      .then((r) => {
        setPats(r.pats);
        setState("ready");
      })
      .catch(() => setState("error"));
  }, []);

  useEffect(refresh, [refresh]);

  const mint = async () => {
    setError(null);
    try {
      const created = await tenantApi.mintPat(name || "pat");
      setMinted(created.token);
      setName("");
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  const revoke = async (id: string) => {
    setError(null);
    try {
      await tenantApi.revokePat(id);
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <section className="user-card">
      <h2>{t("tenant.pats.title")}</h2>
      <p className="user-pat-hint">{t("userPanel.patHint")}</p>
      {minted ? (
        <div className="user-pat-minted">
          <p>{t("tenant.pats.copyNow")}</p>
          <code>{minted}</code>
          <Button variant="outline" size="sm" onClick={() => setMinted(null)}>
            {t("common.close")}
          </Button>
        </div>
      ) : null}
      {error ? <InlineError message={error} /> : null}
      {state === "loading" ? (
        <Loader2 className="spin" size={18} />
      ) : pats.length === 0 ? (
        <EmptyState title={t("tenant.pats.title")} description={t("tenant.pats.empty")} />
      ) : (
        <ul className="user-connection-list">
          {pats.map((p) => (
            <li key={p.id}>
              <span className="user-connection-name">{p.name}</span>
              <span className="user-pat-used">{p.lastUsedAt ?? t("tenant.pats.neverUsed")}</span>
              <Button variant="ghost" size="sm" onClick={() => revoke(p.id)}>
                <Trash2 size={14} /> {t("tenant.pats.revoke")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="user-connection-form">
        <div className="user-form-row">
          <Label>{t("tenant.pats.name")}</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-agent" />
        </div>
        <Button onClick={mint}>
          <KeyRound size={14} /> {t("tenant.pats.mint")}
        </Button>
      </div>
    </section>
  );
}

function TestRunCard(props: { connectionNames: string[] }): ReactNode {
  const t = useTranslate();
  const [actionId, setActionId] = useState("");
  const [connectionName, setConnectionName] = useState("");
  const [inputJson, setInputJson] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const input = JSON.parse(inputJson) as unknown;
      const outcome = await tenantApi.testAction({
        actionId,
        input,
        connectionName: connectionName || undefined,
      });
      setResult(JSON.stringify(outcome, null, 2));
    } catch (e) {
      setResult(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="user-card">
      <h2>{t("tenant.testRun.title")}</h2>
      <div className="user-connection-form">
        <div className="user-form-row">
          <Label>actionId</Label>
          <Input
            value={actionId}
            onChange={(e) => setActionId(e.target.value)}
            placeholder="github.list_repositories"
          />
        </div>
        <div className="user-form-row">
          <Label>{t("tenant.connections.name")}</Label>
          <Select value={connectionName} onValueChange={setConnectionName}>
            <SelectTrigger>
              <SelectValue placeholder="default" />
            </SelectTrigger>
            <SelectContent>
              {props.connectionNames.map((n) => (
                <SelectItem key={n} value={n}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="user-form-row">
          <Label>input (JSON)</Label>
          <Input value={inputJson} onChange={(e) => setInputJson(e.target.value)} />
        </div>
        <Button disabled={busy || !actionId} onClick={run}>
          {busy ? <Loader2 className="spin" size={14} /> : null} {t("tenant.testRun.run")}
        </Button>
        {result ? <pre className="user-test-result">{result}</pre> : null}
      </div>
    </section>
  );
}

function Centered(props: { children: ReactNode }): ReactNode {
  return <div className="user-centered">{props.children}</div>;
}

/**
 * Recent runs for this tenant (add-tenant-runs-card). A troubleshooting view,
 * not a main path: collapsed by default, fetched on first open, refreshed by
 * hand. Everything shown here was already redacted server-side.
 */
export function RunsCard(): ReactNode {
  const t = useTranslate();
  const [runs, setRuns] = useState<TenantRun[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    setLoaded(true);
    setState("loading");
    tenantApi
      .runs()
      .then((r) => {
        setRuns(r.runs);
        setState("ready");
      })
      .catch((e) => {
        setError(e instanceof ApiError ? e.message : String(e));
        setState("error");
      });
  }, []);

  return (
    <section className="user-card">
      <details
        className="user-noauth-group"
        onToggle={(e) => {
          if ((e.currentTarget as HTMLDetailsElement).open && !loaded) refresh();
        }}
      >
        <summary>
          {t("tenant.runs.title")}
          <span className="user-noauth-count">{runs.length}</span>
        </summary>
        {error ? <InlineError message={error} /> : null}
        <div className="user-runs-actions">
          <Button variant="ghost" size="sm" onClick={refresh} disabled={state === "loading"}>
            <RefreshCw size={14} /> {t("common.refresh")}
          </Button>
        </div>
        {!loaded ? (
          <p className="user-picker-count">{t("tenant.runs.hint")}</p>
        ) : state === "loading" ? (
          <Loader2 className="spin" size={18} />
        ) : runs.length === 0 ? (
          <EmptyState title={t("tenant.runs.title")} description={t("tenant.runs.empty")} />
        ) : (
          <ul className="user-runs-list">
            {runs.map((run) => (
              <li key={run.id}>
                <StatusDot ok={run.ok} />
                <span className="user-run-action">{run.actionId ?? "—"}</span>
                <span className="user-run-meta">
                  {new Date(run.startedAt).toLocaleString()} · {run.durationMs}ms
                  {run.connectionName ? ` · ${run.connectionName}` : ""}
                  {run.patName ? ` · ${run.patName}` : ` · ${t("tenant.runs.externalToken")}`}
                </span>
                {run.ok ? null : (
                  <span className="user-run-error">
                    {run.errorCode ?? "error"}
                    {run.errorMessage ? ` · ${run.errorMessage}` : ""}
                  </span>
                )}
                {run.inputSummary !== undefined ? (
                  <details className="user-run-payload">
                    <summary>{t("tenant.runs.input")}</summary>
                    <pre>{JSON.stringify(run.inputSummary, null, 2)}</pre>
                  </details>
                ) : null}
                {run.outputSummary !== undefined ? (
                  <details className="user-run-payload">
                    <summary>{t("tenant.runs.output")}</summary>
                    <pre>{JSON.stringify(run.outputSummary, null, 2)}</pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}
