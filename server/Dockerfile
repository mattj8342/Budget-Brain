FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY target-semantics.mjs server.mjs sustainability.mjs sustainability-service.mjs impacts.mjs impact-service.mjs transaction-batch.mjs diagnostics.mjs budget-policy.mjs auth.mjs household.mjs cloud-store.mjs write-gate.mjs allocation.mjs paycheck.mjs allocation-history.mjs ./
USER node
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
