# rulio-agent for VMs: Claude Code, OpenCode + rulio-agent in one container.
#
#   docker build -t rulio-agent .
#   docker run -d --restart unless-stopped --name agentio \
#     -v agentio-keys:/home/agent/.rulio-agent \
#     -e RULIO_TOKEN=rulio_… \
#     -e CLAUDE_CODE_OAUTH_TOKEN=…   # create once with `claude setup-token`
#     -e OPENCODE_API_KEY=…          # only for keys with their own model (or agentio set-provider-key)
#     rulio-agent
#
# More accounts in the same container, no restart needed:
#
#   docker exec agentio agentio add-key rulio_…
#
# Set or replace the provider key, no restart needed (asked for hidden):
#
#   docker exec -it agentio agentio set-provider-key opencode
#
# The Claude login is yours: the token comes from `claude setup-token` on your
# machine and is only passed on to Claude Code.
# Node fest auf einen gepatchten Stand (rulio-tickets#476: RCE-Lücke in Node 22
# vor 22.23.4). Höher nur bewusst: Tag hier und node-version in image.yml.
FROM node:22.23.4-slim

# OpenCode with a fixed version: its behaviour is part of the safeguards (src/opencode.ts). Higher only on purpose, after checking them again
ARG OPENCODE_VERSION=1.19.5
RUN npm install -g @anthropic-ai/claude-code opencode-ai@${OPENCODE_VERSION} \
  && useradd --create-home agent

# What OpenCode would otherwise fetch during every run: its plugin package with
# dependencies (188 MB in a run, /tmp has 64 MB on the VM) and ripgrep, which
# could not start from /tmp anyway (noexec). src/opencode.ts links the packages in
RUN apt-get update && apt-get install -y --no-install-recommends ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /opt/opencode-deps && cd /opt/opencode-deps \
  && echo "{\"dependencies\":{\"@opencode-ai/plugin\":\"${OPENCODE_VERSION}\"}}" > package.json \
  && npm install --no-audit --no-fund --ignore-scripts --cache /tmp/npm-cache \
  && rm -rf /tmp/npm-cache

WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install --no-audit --no-fund && npx tsc -p tsconfig.json && npm prune --omit=dev \
  && chmod +x dist/cli.js && ln -s /app/dist/cli.js /usr/local/bin/agentio && ln -s /app/dist/cli.js /usr/local/bin/rulio-agent \
  && install -d -o agent -g agent -m 700 /home/agent/.rulio-agent

# The added keys survive a new container; the volume takes over this owner and mode.
# Mount a named volume here (scripts/agentio.sh: agentio-keys). Without one Docker
# creates an unnamed volume that is hard to find again when the container is created anew
VOLUME /home/agent/.rulio-agent

USER agent
ENV RULIO_URL=https://api.rulio.net
CMD ["node", "dist/cli.js", "run"]
