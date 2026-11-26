import type { ProviderDefinition } from "../../core/types.ts";

import { inappNotifyActions } from "./actions.ts";

export const provider: ProviderDefinition = {
  service: "inapp-notify",
  displayName: "FindData In-App Notifications",
  description:
    "Issue a deployment-wide in-app broadcast (audience, title, body, optional action) through FindData's platform gateway.",
  categories: ["Communication", "Productivity"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "gatewayUrl",
          label: "Gateway URL",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "https://paas.example.com",
          description:
            "The base URL of the platform gateway that owns POST /api/broadcast, without a path. Cloud-metadata, loopback, and private targets are blocked by the runtime's SSRF guard.",
        },
        {
          key: "accountToken",
          label: "Account Token",
          inputType: "password",
          required: true,
          secret: true,
          description:
            "An app or mini-program JWT for an account in the admin group, sent as Authorization: Bearer. Issuing a broadcast requires an admin identity; the gateway's machine secret opens only the pull/receipt lanes, not this one. Tokens expire, so an expired token surfaces as an authorization failure.",
        },
      ],
    },
  ],
  actions: inappNotifyActions,
};
