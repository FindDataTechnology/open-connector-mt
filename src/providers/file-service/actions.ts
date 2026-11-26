import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "file-service";

const nonEmptyString = (description: string) => s.string({ description, minLength: 1, pattern: "\\S" });

const ownerSchema = nonEmptyString(
  "Opaque owner domain string, such as wire:cust_x. The service never parses it; cross-domain files never appear.",
);

const fileIdSchema = nonEmptyString("The service-issued file id (32 hex characters).");

const sha256Schema = s.string("The lowercase hex SHA-256 of the bytes, exactly 64 characters.", {
  minLength: 64,
  maxLength: 64,
});

// 两个确认/取用接口都把 file_id 放进路径、owner 放进查询串——沿用上游字段名。
const uploadInputSchema = s.object(
  "Input payload for requesting a presigned upload grant.",
  {
    owner: ownerSchema,
    size: s.integer("The exact byte size of the file to upload.", { minimum: 1 }),
    sha256: sha256Schema,
    mime: s.string("The file MIME type; defaults to application/octet-stream.", {
      default: "application/octet-stream",
    }),
    filename: s.string("An optional display filename."),
    use_post_policy: s.boolean({
      description:
        "When true (default) the grant is a POST policy that pins size and type into the signature; false degrades to a plain PUT URL.",
      default: true,
    }),
  },
  { required: ["owner", "size", "sha256"], optional: ["mime", "filename", "use_post_policy"] },
);

const confirmInputSchema = s.object(
  "Input payload for confirming an uploaded file so it counts toward quota and listing.",
  { file_id: fileIdSchema, owner: ownerSchema },
  { required: ["file_id", "owner"] },
);

const downloadInputSchema = s.object(
  "Input payload for requesting a time-limited download URL.",
  {
    file_id: fileIdSchema,
    owner: ownerSchema,
    ttl: s.integer("Validity in seconds; the service clamps it to its configured upper bound.", { minimum: 1 }),
  },
  { required: ["file_id", "owner"], optional: ["ttl"] },
);

const listInputSchema = s.object(
  "Input payload for listing one owner's confirmed files.",
  {
    owner: ownerSchema,
    mime: s.string("Exact MIME type filter."),
    mime_prefix: s.string("MIME prefix filter, such as image/ or application/vnd."),
    created_after: s.string("ISO8601 lower bound on created_at (alias of since)."),
    created_before: s.string("ISO8601 upper bound on created_at (alias of until)."),
    limit: s.integer("Maximum rows in this page.", { minimum: 1, maximum: 1000, default: 100 }),
    offset: s.integer("Rows to skip for pagination.", { minimum: 0, default: 0 }),
  },
  {
    required: ["owner"],
    optional: ["mime", "mime_prefix", "created_after", "created_before", "limit", "offset"],
  },
);

// 集合信封：ERP 的 RuntimeClient 取第一个对象数组，每行必须带 id（见 rows 里的 id）。
const uploadsOutputSchema = s.object("The presigned upload grant(s).", {
  assets: s.array(
    "One entry per issued upload grant.",
    s.object(
      "An issued upload grant.",
      {
        id: s.string("The file id. Equals the upstream file_id."),
        upload_url: s.string("The presigned upload URL the client PUTs or POSTs bytes to."),
        method: s.string("The HTTP method to use against upload_url."),
        fields: s.nullable(s.record("Form fields to include when method is POST.")),
        storage_key: s.string("The storage object key the bytes land under."),
        expires_in: s.integer("Seconds until the upload grant expires."),
        dedup: s.boolean("Whether an identical byte object already existed (request de-duplicated)."),
      },
      { optional: ["fields"] },
    ),
  ),
});

const assetRowSchema = s.object(
  "One file asset.",
  {
    id: s.string("The file id. Equals the upstream file_id."),
    owner: s.string("The owner domain string."),
    sha256: s.string("The hex SHA-256 of the bytes."),
    size: s.integer("The byte size."),
    mime: s.string("The file MIME type."),
    filename: s.nullableString("The display filename, or null."),
    status: s.string("The asset status, such as live or deleted."),
    created_at: s.string("The ISO8601 creation timestamp."),
    confirmed_at: s.nullableString("The ISO8601 confirmation timestamp, or null when unconfirmed."),
  },
  { optional: ["filename", "confirmed_at"] },
);

const confirmOutputSchema = s.object("The confirmed file asset(s).", {
  assets: s.array("One entry per confirmed file.", assetRowSchema),
});

const downloadsOutputSchema = s.object("The issued download URL(s).", {
  downloads: s.array(
    "One entry per issued download URL.",
    s.object(
      "A time-limited download URL.",
      {
        id: s.string("The file id. Equals the upstream file_id."),
        download_url: s.string("The time-limited presigned download URL."),
        method: s.string("The HTTP method to use against download_url."),
        expires_in: s.integer("Validity in seconds; matches the signed duration."),
        expires_at: s.string("The ISO8601 UTC expiry instant."),
        content_type: s.string("The stored MIME type."),
        size: s.integer("The byte size."),
      },
      { optional: ["method", "expires_in", "expires_at", "content_type", "size"] },
    ),
  ),
});

const listOutputSchema = s.object("One page of an owner's files.", {
  files: s.array("The files in this page.", assetRowSchema),
  pageInfo: s.object(
    "Pagination metadata from the upstream count query.",
    {
      count: s.integer("Rows returned in this page."),
      total: s.integer("Total matching rows."),
      limit: s.integer("The requested page size."),
      offset: s.integer("The requested offset."),
      hasMore: s.boolean("Whether more rows exist past this page."),
    },
    { optional: ["count", "total", "limit", "offset", "hasMore"] },
  ),
});

export const fileServiceActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "create_upload_url",
    operationType: "write",
    description: "Request a presigned upload grant (bytes never pass through the service).",
    inputSchema: uploadInputSchema,
    outputSchema: uploadsOutputSchema,
  }),
  defineProviderAction(service, {
    name: "confirm_upload",
    operationType: "write",
    description: "Confirm an uploaded file so it counts toward quota and appears in listings.",
    inputSchema: confirmInputSchema,
    outputSchema: confirmOutputSchema,
  }),
  defineProviderAction(service, {
    name: "get_download_url",
    operationType: "read",
    description: "Issue a time-limited download URL for one file.",
    inputSchema: downloadInputSchema,
    outputSchema: downloadsOutputSchema,
  }),
  defineProviderAction(service, {
    name: "list_files",
    operationType: "read",
    description: "List one owner's confirmed files with type/time filters and offset pagination.",
    inputSchema: listInputSchema,
    outputSchema: listOutputSchema,
  }),
];
