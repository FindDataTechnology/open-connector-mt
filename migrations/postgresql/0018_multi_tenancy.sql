-- Multi-tenancy (open-connector-mt), PostgreSQL dialect.
-- Same schema as migrations/0018_multi_tenancy.sql: tenants / identities /
-- consents, tenant columns, and connections rebuilt onto
-- (tenant_id, service, connection_name). Pre-existing rows land on the
-- bootstrap tenant "local-admin" (platform-level OAuth client configs on
-- "platform"), keeping upstream behavior under TENANCY=off.

create table tenants (
  id text primary key,
  kind text not null default 'user',
  created_at text not null,
  disabled_at text
);

create table identities (
  id text primary key,
  tenant_id text not null references tenants(id),
  issuer text not null,
  subject text not null,
  email text,
  display_name text,
  created_at text not null,
  disabled_at text
);

create unique index identities_issuer_subject on identities (issuer, subject);
create index identities_tenant on identities (tenant_id);

create table consents (
  tenant_id text not null references tenants(id),
  token_id text not null references runtime_tokens(id),
  granted_at text not null,
  primary key (tenant_id, token_id)
);

alter table connections add column tenant_id text not null default 'local-admin';
alter table oauth_states add column tenant_id text not null default 'local-admin';
alter table oauth_client_configs add column tenant_id text not null default 'platform';
alter table runtime_tokens add column tenant_id text;
alter table runtime_tokens add column kind text not null default 'runtime';
alter table runs add column tenant_id text;
create index runs_tenant on runs (tenant_id);

create table connections_next (
  id text not null unique,
  tenant_id text not null default 'local-admin',
  revision text not null default '',
  service text not null,
  connection_name text not null,
  value text not null,
  updated_at text not null,
  source text not null default 'local' check (source in ('local', 'saas')),
  managed_project_id text,
  provider_config_id text,
  external_user_id text,
  remote_account_id text,
  local_request_id text,
  provider_account_id text,
  primary key (tenant_id, service, connection_name)
);

insert into connections_next (
  id, tenant_id, revision, service, connection_name, value, updated_at,
  source, managed_project_id, provider_config_id, external_user_id,
  remote_account_id, local_request_id, provider_account_id
)
select
  id, tenant_id, revision, service, connection_name, value, updated_at,
  source, managed_project_id, provider_config_id, external_user_id,
  remote_account_id, local_request_id, provider_account_id
from connections;

drop table connections;
alter table connections_next rename to connections;

create index connections_tenant on connections (tenant_id);
