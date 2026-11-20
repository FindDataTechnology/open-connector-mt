import type { ProviderDefinition } from "../../core/types.ts";

import { alipayActions } from "./actions.ts";
import { snapshot as tradeNotifySnapshot } from "./trigger-trade-notify.definition.ts";

const authorizationHelp =
  "All values come from the Alipay open platform console (open.alipay.com, 应用详情 > 开发设置).";

export const provider: ProviderDefinition = {
  service: "alipay",
  displayName: "Alipay",
  description:
    "Merchant-side read-only access to Alipay: trade queries and settlement day bill downloads for daily channel reconciliation, plus async trade notification triggers.",
  categories: ["Finance"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      label: "Alipay Open Platform App",
      description:
        "Open platform application credentials in public key mode. This provider is read-only: it never initiates payments, refunds, or transfers.",
      fields: [
        {
          key: "appId",
          label: "App ID",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "2021000000000000",
          description: `The open platform application ID (应用 AppID). ${authorizationHelp}`,
        },
        {
          key: "appPrivateKey",
          label: "Application Private Key",
          inputType: "textarea",
          required: true,
          secret: true,
          placeholder: "-----BEGIN PRIVATE KEY-----",
          description: `The application private key (应用私钥, PKCS#8 PEM) matching the application public key configured on the open platform. ${authorizationHelp}`,
        },
        {
          key: "alipayPublicKey",
          label: "Alipay Public Key (optional)",
          inputType: "textarea",
          required: false,
          secret: false,
          placeholder: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A...",
          description:
            "The Alipay public key (支付宝公钥) in public key mode, base64 or PEM. Used to verify gateway response signatures and async notification signatures.",
        },
        {
          key: "gatewayUrl",
          label: "Gateway URL (optional)",
          inputType: "text",
          required: false,
          secret: false,
          placeholder: "https://openapi.alipay.com/gateway.do",
          description: "Optional open API gateway override (网关). Defaults to https://openapi.alipay.com/gateway.do.",
        },
      ],
    },
  ],
  homepageUrl: "https://open.alipay.com/",
  actions: alipayActions,
  triggers: [tradeNotifySnapshot],
};
