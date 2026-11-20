export const triggerPermissions: readonly import("../../triggers/metadata.ts").TriggerPermission[] = [
  {
    id: "alipay.trade_notify",
    name: "Trade Notify",
    description:
      "Receives Alipay async trade notifications on the runtime webhook ingress and verifies their RSA2 signatures against the subscription's Alipay public key.",
    providerPermissions: [],
    instructions:
      "Configure the open platform application credentials, paste the Alipay public key into the subscription, and point the application's async notification URL at this runtime's callback URL. Alipay delivers notifications as form-encoded posts; the public ingress must forward them as a JSON object of the same string fields. Trigger reconcile checks the application credentials with a signed trade query.",
  },
];
