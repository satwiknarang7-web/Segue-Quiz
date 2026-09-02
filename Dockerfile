# SegueQuiz has no dependencies and no build step, so this image is just
# Node plus the source. Works on Railway, Fly, Cloud Run or plain Docker.

FROM node:22-alpine

WORKDIR /app

# Copied separately so the manifest is present for tooling that reads it.
COPY package.json ./
COPY src ./src
COPY public ./public

# The data directory is only used when Supabase is not configured, and for the
# locally generated secrets fallback. It must be writable by the runtime user.
RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

# The platform's health check should point at /healthz.
CMD ["node", "src/server.js"]
