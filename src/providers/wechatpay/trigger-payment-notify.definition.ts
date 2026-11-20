import type { TriggerKeySnapshot } from "../../triggers/common/types.ts";

import { jsonSchema as s } from "../../core/json-schema.ts";

export const snapshot: TriggerKeySnapshot & { readonly type: "integration" } = {
  configInputs: [
    {
      handle: "platformCertificate",
      jsonSchema: s.string({
        minLength: 1,
        description:
          "WeChat Pay platform certificate (微信支付平台证书) in PEM format, from the merchant platform API safety center. Callback signatures are verified against this public certificate.",
      }),
      nullable: false,
    },
    {
      handle: "eventTypes",
      jsonSchema: s.array(s.stringPattern("^\\*$|^[A-Z]+(\\.[A-Z0-9]+)+$"), {
        minItems: 1,
        uniqueItems: true,
        itemDescription: "One APIv3 event type (event_type), for example TRANSACTION.SUCCESS, or * for all events.",
      }),
      nullable: false,
      value: ["*"],
    },
  ],
  definitionVersion: 1,
  description:
    "Triggers on WeChat Pay merchant payment result notifications (支付结果通知) delivered to this runtime's webhook ingress. The delivery must carry valid APIv3 signature headers and is verified against the configured platform certificate.",
  displayName: "Payment Notify",
  endpoint: {
    body: { allowArray: false, allowEmpty: false, formats: ["json"] },
    methods: ["POST"],
    successStatus: 202,
  },
  key: "wechatpay.payment_notify",
  name: "payment_notify",
  outputs: [
    { handle: "body", jsonSchema: { type: "object" }, nullable: false },
    { handle: "event", jsonSchema: s.string(), nullable: false },
    { handle: "eventId", jsonSchema: s.string(), nullable: false },
    { handle: "mchid", jsonSchema: s.string(), nullable: true },
    { handle: "outTradeNo", jsonSchema: s.string(), nullable: true },
    { handle: "transactionId", jsonSchema: s.string(), nullable: true },
    { handle: "tradeState", jsonSchema: s.string(), nullable: true },
  ],
  provider: "wechatpay",
  type: "integration",
};
