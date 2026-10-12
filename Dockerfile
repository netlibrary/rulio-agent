# rulio-agent für VMs: Claude Code + rulio-agent in einem Container.
#
#   docker build -t rulio-agent .
#   docker run -d --restart unless-stopped \
#     -e RULIO_TOKEN=rulio_… \
#     -e CLAUDE_CODE_OAUTH_TOKEN=…   # einmal mit `claude setup-token` erzeugen
#     rulio-agent
#
# Der Claude-Login gehört dir: Das Token kommt aus `claude setup-token` auf
# deinem Rechner und wird nur an Claude Code weitergegeben.
FROM node:22-slim

RUN npm install -g @anthropic-ai/claude-code \
  && useradd --create-home agent

WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install --no-audit --no-fund && npx tsc -p tsconfig.json && npm prune --omit=dev

USER agent
ENV RULIO_URL=https://api.rulio.net
CMD ["node", "dist/cli.js", "run"]
