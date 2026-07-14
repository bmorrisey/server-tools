# server-tools agent image. Runtime is plain Node with zero npm dependencies;
# git and docker-cli-compose are included so the deploy helper can run
# "git checkout" + "docker compose up" against bind-mounted app directories.
FROM node:22-alpine

RUN apk add --no-cache tar git docker-cli docker-cli-compose

WORKDIR /app
COPY package.json ./
COPY src ./src

# The agent reads config.json (mount it) and writes state under /data.
ENV SERVER_TOOLS_CONFIG=/app/config.json
ENV NODE_ENV=production

EXPOSE 9090
CMD ["node", "src/agent.js"]
