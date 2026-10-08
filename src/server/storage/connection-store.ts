import type { IConnectionStore, StoredConnection, StoredLocalConnection } from "../../connection-service.ts";
import type { ResolvedCredential } from "../../core/types.ts";
import type { ISecretCodec } from "../secrets/secret-codec-core.ts";
import { BOOTSTRAP_TENANT_ID } from "../tenancy/constants.ts";
import { currentStoreTenant } from "../tenancy/request-context.ts";
import type { RequestTransaction } from "./connection-request-store.ts";
import type { RuntimeRow } from "./runtime-sql.ts";

import { HttpRequestError } from "../api/http-utils.ts";
import { queueSaasConnections, readSaasConnection } from "./saas-project-store.ts";

/** Connection writes share the request transaction so replacing/deleting remote references cannot lose cleanup work. */
export class SqlConnectionStore implements IConnectionStore {
  private readonly transaction: RequestTransaction;
  private readonly codec: ISecretCodec;

  constructor(transaction: RequestTransaction, codec: ISecretCodec) {
    this.transaction = transaction;
    this.codec = codec;
  }

  // open-connector-mt: every method takes an optional trailing tenantId.
  // Absent = bootstrap tenant, which is exactly the upstream single-tenant
  // behavior, so TENANCY=off callers stay byte-compatible. In tenant mode the
  // caller passes the principal's tenant and cross-tenant reads/writes are
  // impossible through this store.
  private async read(row: RuntimeRow): Promise<StoredConnection> {
    if (row.source === "saas") return readSaasConnection(row, this.codec);
    return {
      id: row.id as string,
      revision: row.revision as string,
      service: row.service as string,
      connectionName: row.connection_name as string,
      tenantId: (row.tenant_id as string) || BOOTSTRAP_TENANT_ID,
      credential: JSON.parse(await this.codec.decode(row.value as string)) as ResolvedCredential,
    };
  }

  async get(service: string, connectionName: string, tenantId: string = currentStoreTenant()): Promise<StoredConnection | undefined> {
    const [[row]] = await this.transaction([
      {
        sql: "select * from connections where service = ? and connection_name = ? and tenant_id = ?",
        values: [service, connectionName, tenantId],
      },
    ]);
    return row ? this.read(row) : undefined;
  }

  async list(tenantId: string = currentStoreTenant()): Promise<StoredConnection[]> {
    const [rows] = await this.transaction([
      { sql: "select * from connections where tenant_id = ? order by service, connection_name", values: [tenantId] },
    ]);
    return Promise.all(rows.map((row) => this.read(row)));
  }

  async set(
    service: string,
    connectionName: string,
    credential: ResolvedCredential,
    tenantId: string = currentStoreTenant(),
  ): Promise<StoredLocalConnection> {
    const value = await this.codec.encode(JSON.stringify(credential));
    const [, , [row]] = await this.transaction([
      {
        sql: "update connections set revision = revision where service = ? and connection_name = ? and tenant_id = ?",
        values: [service, connectionName, tenantId],
      },
      queueSaasConnections("service = ? and connection_name = ? and tenant_id = ?", [service, connectionName, tenantId]),
      {
        sql: `insert into connections (id, tenant_id, revision, service, connection_name, value, updated_at, provider_account_id)
          values (?, ?, ?, ?, ?, ?, ?, ?) on conflict (tenant_id, service, connection_name) do update set
          revision = excluded.revision, value = excluded.value, updated_at = excluded.updated_at,
          source = 'local', managed_project_id = null, provider_config_id = null, external_user_id = null,
          remote_account_id = null, local_request_id = null, provider_account_id = excluded.provider_account_id
          where not exists (select 1 from trigger_subscriptions where connection_id = connections.id and mode <> 'resource-set' and status in ('active', 'deleting'))
          or (connections.provider_account_id is not null and connections.provider_account_id = excluded.provider_account_id) returning id, revision`,
        values: [
          crypto.randomUUID(),
          tenantId,
          crypto.randomUUID(),
          service,
          connectionName,
          value,
          new Date().toISOString(),
          credential.authType !== "no_auth" && credential.metadata.providerAccountVerified === true
            ? credential.profile.accountId
            : null,
        ],
      },
    ]);
    if (!row)
      throw new HttpRequestError(
        "connection_has_subscriptions",
        "Cancel or abandon remote Trigger subscriptions before replacing this connection.",
        409,
      );
    return { id: row.id as string, revision: row.revision as string, service, connectionName, tenantId, credential };
  }

  async updateCredential(input: StoredLocalConnection, refresh = false): Promise<boolean> {
    const value = await this.codec.encode(JSON.stringify(input.credential));
    const tenantId = input.tenantId || currentStoreTenant();
    const [, [row]] = await this.transaction([
      { sql: "update connections set revision = revision where id = ?", values: [input.id] },
      {
        sql: `update connections set revision = ?, value = ?, updated_at = ?, provider_account_id = ?
        where service = ? and connection_name = ? and tenant_id = ? and id = ? and revision = ? and source = 'local'
        and (? = 1 or not exists (select 1 from trigger_subscriptions where connection_id = connections.id and mode <> 'resource-set' and status in ('active', 'deleting'))
        or (provider_account_id is not null and provider_account_id = ?)) returning id`,
        values: [
          crypto.randomUUID(),
          value,
          new Date().toISOString(),
          input.credential.authType !== "no_auth" && input.credential.metadata.providerAccountVerified === true
            ? input.credential.profile.accountId
            : null,
          input.service,
          input.connectionName,
          tenantId,
          input.id,
          input.revision,
          refresh ? 1 : 0,
          input.credential.authType !== "no_auth" && input.credential.metadata.providerAccountVerified === true
            ? input.credential.profile.accountId
            : null,
        ],
      },
    ]);
    return row !== undefined;
  }

  async delete(service: string, connectionName: string, tenantId: string = currentStoreTenant()): Promise<void> {
    const [, , , [remaining]] = await this.transaction([
      {
        sql: "update connections set revision = revision where service = ? and connection_name = ? and tenant_id = ?",
        values: [service, connectionName, tenantId],
      },
      queueSaasConnections("service = ? and connection_name = ? and tenant_id = ?", [service, connectionName, tenantId]),
      {
        sql: `delete from connections where service = ? and connection_name = ? and tenant_id = ? and not exists
        (select 1 from trigger_subscriptions where connection_id = connections.id and mode <> 'resource-set' and status in ('active', 'deleting'))`,
        values: [service, connectionName, tenantId],
      },
      {
        sql: "select id from connections where service = ? and connection_name = ? and tenant_id = ?",
        values: [service, connectionName, tenantId],
      },
    ]);
    if (remaining)
      throw new HttpRequestError(
        "connection_has_subscriptions",
        "Cancel or abandon remote Trigger subscriptions before disconnecting this connection.",
        409,
      );
  }
}
