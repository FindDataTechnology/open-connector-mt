import type { ProviderDefinition } from "../../core/types.ts";

import { wechatPayActions } from "./actions.ts";
import { snapshot as paymentNotifySnapshot } from "./trigger-payment-notify.definition.ts";

const authorizationHelp =
  "All values come from the WeChat Pay merchant platform API safety center (pay.weixin.qq.com, Account Center > API Safety).";

export const provider: ProviderDefinition = {
  service: "wechatpay",
  displayName: "WeChat Pay",
  description:
    "Merchant-side read-only access to WeChat Pay: transaction queries and settlement day bill downloads for daily channel reconciliation, plus payment result notification triggers.",
  categories: ["Finance"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      label: "WeChat Pay Merchant APIv3",
      description:
        "Direct merchant mode credentials. This provider is read-only: it never initiates payments, refunds, or transfers.",
      fields: [
        {
          key: "mchid",
          label: "Merchant ID (mchid)",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "1900000000",
          description: `The WeChat Pay merchant ID (商户号). ${authorizationHelp}`,
        },
        {
          key: "appId",
          label: "App ID (optional)",
          inputType: "text",
          required: false,
          secret: false,
          placeholder: "wx8888888888888888",
          description:
            "Optional App ID (公众号/小程序/移动端应用) that owns the payments, carried in notifications and reports.",
        },
        {
          key: "merchantApiCertificatePrivateKey",
          label: "API Certificate Private Key",
          inputType: "textarea",
          required: true,
          secret: true,
          placeholder: "-----BEGIN PRIVATE KEY-----",
          description: `The merchant API certificate private key (apiclient_key.pem, PKCS#8 PEM) used to sign APIv3 requests. ${authorizationHelp}`,
        },
        {
          key: "merchantCertificateSerialNo",
          label: "Certificate Serial Number",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "5157F09EFDC096DE15EBE81A47057A72",
          description: `The serial number (证书序列号) of the merchant API certificate. ${authorizationHelp}`,
        },
        {
          key: "apiv3Key",
          label: "APIv3 Key",
          inputType: "password",
          required: true,
          secret: true,
          placeholder: "32-character APIv3 key",
          description: `The 32-character APIv3 key (APIv3密钥) set in the API safety center. ${authorizationHelp}`,
        },
        {
          key: "platformCertificate",
          label: "Platform Certificate (optional)",
          inputType: "textarea",
          required: false,
          secret: false,
          placeholder: "-----BEGIN CERTIFICATE-----",
          description:
            "Optional WeChat Pay platform certificate (微信支付平台证书) PEM used by the payment notification trigger to verify callback signatures.",
        },
      ],
    },
  ],
  homepageUrl: "https://pay.weixin.qq.com/",
  actions: wechatPayActions,
  triggers: [paymentNotifySnapshot],
};
