import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "inapp-notify";

// 受众选择器：kind 决定哪个 id/ids 字段必填（上游 AUDIENCE_KINDS）。
const audienceSchema = s.object(
  "Declarative audience selector. The gateway expands it once; a failed expansion refuses the broadcast.",
  {
    kind: s.stringEnum(["org", "role", "userIds", "all"], { description: "The audience kind." }),
    id: s.string("The org or role identifier; required when kind is org or role."),
    ids: s.array("Explicit recipient emails; required when kind is userIds.", s.string("One recipient email."), {
      maxItems: 500,
    }),
  },
  { required: ["kind"], optional: ["id", "ids"] },
);

const actionSchema = s.object(
  "An optional registered action carried by the notice.",
  {
    actionId: s.string("A registered platform action id.", { minLength: 1 }),
    args: s.record("Arguments passed to the action; defaults to an empty object."),
  },
  { required: ["actionId"], optional: ["args"] },
);

const sendInputSchema = s.object(
  "Input payload for issuing one in-app broadcast.",
  {
    audience: audienceSchema,
    title: s.string("The notice title, truncated by the gateway to 200 characters."),
    body: s.string("The notice body; required and capped at 4000 characters.", { minLength: 1, maxLength: 4000 }),
    action: actionSchema,
    wake: s.stringEnum(["none", "batch", "immediate"], {
      description: "How recipients' agents are woken.",
      default: "none",
    }),
  },
  { required: ["audience", "body"], optional: ["title", "action", "wake"] },
);

// 集合信封：ERP 客户端取第一个对象数组，每行必须带 id。
const sendOutputSchema = s.object("The recorded broadcast(s).", {
  broadcasts: s.array(
    "One entry per recorded broadcast.",
    s.object(
      "A recorded broadcast with honest delivery counters.",
      {
        id: s.string("The broadcast id."),
        seq: s.integer("The monotonically increasing ledger sequence number."),
        audience: audienceSchema,
        audienceLabel: s.string("Human-readable description of the resolved audience."),
        hitCount: s.integer("How many recipients the audience resolved to."),
        okCount: s.integer("Delivered count; grows only from node receipts, starts at 0."),
        failCount: s.integer("Failed count; grows only from node receipts, starts at 0."),
        wake: s.string("The requested wake mode."),
        im: s.object(
          "Per-recipient IM delivery counters, present only when an IM face is wired.",
          {
            sent: s.integer("IM notices sent."),
            failed: s.integer("IM notices that failed."),
          },
          { optional: ["sent", "failed"] },
        ),
      },
      { optional: ["seq", "audienceLabel", "hitCount", "okCount", "failCount", "wake", "im"] },
    ),
  ),
});

export const inappNotifyActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "send_broadcast",
    operationType: "write",
    description:
      "Record a deployment-wide in-app broadcast for a resolved audience and return its ledger id and reach.",
    inputSchema: sendInputSchema,
    outputSchema: sendOutputSchema,
  }),
];
