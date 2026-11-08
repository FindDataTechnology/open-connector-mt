FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json vitest.config.ts ./
COPY web ./web
COPY src ./src
COPY scripts ./scripts
COPY examples ./examples
RUN npm ci --ignore-scripts
RUN npm run generate:catalog
RUN npm run build
RUN npm run build --workspace web

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV OOMOL_CONNECT_DATA_DIR=/app/data
COPY package.json package-lock.json ./
COPY scripts/healthcheck.ts ./scripts/healthcheck.ts
COPY scripts/ensure-generated.ts ./scripts/ensure-generated.ts
COPY scripts/runtime-data.ts ./scripts/runtime-data.ts
COPY migrations ./migrations
COPY --from=build /app/src ./src
COPY --from=build /app/catalog ./catalog
COPY --from=build /app/dist ./dist
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/open-connector

RUN npm ci --omit=dev --ignore-scripts

# Build provenance, same file name and shape as the platform image, so one
# verifier answers "which commit is this?" for every service in the fleet.
# 2026-11-08: the platform image shipped without this and a manifest comment
# claimed a base the tree did not contain; nothing inside the image could
# contradict it. The connector had no provenance at all.
ARG BUILD_SHA=unknown
ARG BUILD_REF=unknown
RUN printf '%s\n' \
      "{\"baseRef\":\"${BUILD_REF}\",\"baseCommit\":\"${BUILD_SHA}\",\"builtAt\":\"unknown\"}" \
      > /app/BUILD-INFO.json \
 && cat /app/BUILD-INFO.json

VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "scripts/healthcheck.ts"]
ENTRYPOINT ["/usr/local/bin/open-connector"]
CMD ["serve"]
