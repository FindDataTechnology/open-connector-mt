import type { ProviderDefinition } from "../../core/types.ts";

import { fileServiceActions } from "./actions.ts";

export const provider: ProviderDefinition = {
  service: "file-service",
  displayName: "FindData File Service",
  description:
    "Issue presigned uploads, confirm them, and hand out time-limited download URLs on FindData's first-party file service.",
  categories: ["Data", "Developer Tools"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "baseUrl",
          label: "Service URL",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "https://files.example.com",
          description:
            "The base URL of the fd-file-service deployment, without a path. The service itself performs no authentication (auth is the gateway's job), so this connection carries only the endpoint. Public addresses work by default; cloud-metadata, loopback, and private targets are always blocked by the runtime's SSRF guard.",
        },
      ],
    },
  ],
  actions: fileServiceActions,
};
