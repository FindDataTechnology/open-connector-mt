export const triggerPermissions: readonly import("../../triggers/metadata.ts").TriggerPermission[] = [
  {
    id: "wechatpay.payment_notify",
    name: "Payment Notify",
    description:
      "Receives WeChat Pay payment result notifications on the runtime webhook ingress and verifies their APIv3 signatures against the subscription's platform certificate.",
    providerPermissions: [],
    instructions:
      "Configure the merchant APIv3 credentials, paste the WeChat Pay platform certificate into the subscription, and point the merchant platform notification URL at this runtime's callback URL. Trigger reconcile checks the merchant credentials with the platform certificate list API.",
  },
];
