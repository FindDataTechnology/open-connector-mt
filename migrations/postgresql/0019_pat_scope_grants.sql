-- scoped-pat-grants: user PATs may carry a scope (allowed_actions /
-- allowed_connections, added in 0011/0018) and, from this migration, a
-- provenance label and a derivation parent:
--
--   purpose          free-text label so one identity holding N PATs can tell
--                    which token serves which binding/agent.
--   parent_token_id  set when a PAT was minted by attenuating another PAT
--                    (a child's scope is always a subset of its parent's).
--                    Revoking a parent cascades to its descendants.
--
-- Both columns are nullable with no default: existing rows are untouched and
-- TENANCY=off keeps upstream behaviour byte-compatibly.
alter table runtime_tokens add column purpose text;
alter table runtime_tokens add column parent_token_id text;

-- Serves the parent→children lookup performed on revocation.
create index if not exists runtime_tokens_parent on runtime_tokens (parent_token_id);
