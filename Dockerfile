# rulio-agent for VMs: Claude Code + rulio-agent in one container.
#
#   docker build -t rulio-agent .
#   docker run -d --restart unless-stopped --name rulio-agent \
#     -v rulio-agent-keys:/home/agent/.rulio-agent \
#     -e RULIO_TOKEN=rulio_… \
#     -e CLAUDE_CODE_OAUTH_TOKEN=…   # create once with `claude setup-token`
#     rulio-agent
#
# More accounts in the same container, no restart needed:
#
#   docker exec rulio-agent rulio-agent add-key rulio_…
#
# The Claude login is yours: the token comes from `claude setup-token` on your
# machine and is only passed on to Claude Code.
# Node fest auf einen gepatchten Stand (rulio-tickets#476: RCE-Lücke in Node 22
# vor 22.23.4). Höher nur bewusst: Tag hier und node-version in image.yml.
FROM node:22.23.4-slim

RUN npm install -g @anthropic-ai/claude-code \
  && useradd --create-home agent

WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install --no-audit --no-fund && npx tsc -p tsconfig.json && npm prune --omit=dev \
  && chmod +x dist/cli.js && ln -s /app/dist/cli.js /usr/local/bin/rulio-agent \
  && install -d -o agent -g agent -m 700 /home/agent/.rulio-agent

# The added keys survive a new container; the volume takes over this owner and mode
VOLUME /home/agent/.rulio-agent

USER agent
ENV RULIO_URL=https://api.rulio.net
CMD ["node", "dist/cli.js", "run"]
