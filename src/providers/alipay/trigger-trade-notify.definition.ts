import type { TriggerKeySnapshot } from "../../triggers/common/types.ts";

import { jsonSchema as s } from "../../core/json-schema.ts";

const tradeStatuses = ["WAIT_BUYER_PAY", "TRADE_CLOSED", "TRADE_SUCCESS", "TRADE_FINISHED"] as const;

export const snapshot: TriggerKeySnapshot & { readonly type: "integration" } = {
  configInputs: [
    {
      handle: "alipayPublicKey",
      jsonSchema: s.string({
        minLength: 1,
        description:
          "The Alipay public key (支付宝公钥) from the open platform, base64 or PEM. Async notification signatures are verified with this key.",
      }),
      nullable: false,
    },
    {
      handle: "tradeStatuses",
      jsonSchema: s.array(s.stringEnum(tradeStatuses), {
        minItems: 1,
        uniqueItems: true,
        itemDescription: "One trade status (trade_status) that emits an event.",
      }),
      nullable: false,
      value: ["TRADE_SUCCESS", "TRADE_FINISHED"],
    },
  ],
  definitionVersion: 1,
  description:
    "Triggers on Alipay async trade notifications (异步通知) delivered to this runtime's webhook ingress. The delivery fields must carry a valid RSA2 signature, verified against the configured Alipay public key.",
  displayName: "Trade Notify",
  endpoint: {
    body: { allowArray: false, allowEmpty: false, formats: ["json"] },
    methods: ["POST"],
    successStatus: 200,
  },
  key: "alipay.trade_notify",
  name: "trade_notify",
  outputs: [
    { handle: "body", jsonSchema: { type: "object" }, nullable: false },
    { handle: "tradeNo", jsonSchema: s.string(), nullable: true },
    { handle: "outTradeNo", jsonSchema: s.string(), nullable: true },
    { handle: "tradeStatus", jsonSchema: s.string(), nullable: true },
    { handle: "notifyId", jsonSchema: s.string(), nullable: true },
  ],
  provider: "alipay",
  type: "integration",
};
