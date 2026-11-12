#!/usr/bin/env bash
# Agentio on a server: set up, update and restart with one script.
#
#   curl -fsSLo ~/agentio.sh https://raw.githubusercontent.com/netlibrary/rulio-agent/main/scripts/agentio.sh && chmod +x ~/agentio.sh
#   ~/agentio.sh            # set up or update
#
# Always creates the container the same way: name agentio, --restart unless-stopped,
# the named volume agentio-keys for the keys, the variables from ~/agentio.env (mode
# 600) and the newest image. Running it again updates: new image, same settings.
#
# An existing container rulio-agent (or agentio) without the named volume is taken
# over once: its variables go to ~/agentio.env, its key files into agentio-keys.
# The old container is only removed once the new one runs; a volume is never deleted.
# No key and no value of a variable is ever printed.
#
# Settings of the script itself (all optional):
#   AGENTIO_IMAGE=…   another image, for example one you built yourself
#   AGENTIO_PULL=0    do not fetch the image, use the local one (an image you built)
#   AGENTIO_ENV=…     another settings file instead of ~/agentio.env
set -euo pipefail

NAME="agentio"
VOLUME="agentio-keys"
IMAGE="${AGENTIO_IMAGE:-ghcr.io/netlibrary/rulio-agent:latest}"
ENV_FILE="${AGENTIO_ENV:-$HOME/agentio.env}"
KEYS_DIR="/home/agent/.rulio-agent"
# Seconds the new container gets to start before it is checked
WAIT="${AGENTIO_WAIT:-10}"
# Variables of the image itself, not settings of the user
IMAGE_VARS='^(PATH|HOME|HOSTNAME|TERM|NODE_VERSION|YARN_VERSION)='

say() { printf '%s\n' "$*"; }
fail() {
  printf 'agentio.sh: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "docker is not installed or not on the PATH."

exists() { docker container inspect --format '{{.Name}}' "$1" >/dev/null 2>&1; }
# Type and name of what is mounted at the keys folder: "volume agentio-keys", "volume 3f2a…", "bind /x" or empty
keys_mount() {
  docker container inspect --format "{{range .Mounts}}{{if eq .Destination \"$KEYS_DIR\"}}{{.Type}} {{.Name}}{{end}}{{end}}" "$1"
}
# Number of rulio keys in the keys file of a container; the keys themselves stay in the pipe
count_keys() {
  docker cp "$1:$KEYS_DIR/." - 2>/dev/null | tar -xOf - ./keys 2>/dev/null | grep -c '^rulio_' || true
}

# --- Which container is there already?
OLD=""
for candidate in "$NAME" rulio-agent; do
  if exists "$candidate"; then
    OLD="$candidate"
    break
  fi
done

# --- Fetch the image first: if that fails, nothing has changed
if [ "${AGENTIO_PULL:-1}" = "0" ]; then
  docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "There is no local image $IMAGE. Nothing was changed."
else
  say "Fetching $IMAGE …"
  docker pull --quiet "$IMAGE" >/dev/null || fail "Could not fetch $IMAGE. Nothing was changed."
fi

# --- Take over an existing installation: its variables if there is no settings file yet
if [ -n "$OLD" ] && [ ! -e "$ENV_FILE" ]; then
  (
    umask 077
    {
      echo "# Variables for Agentio, taken over from the container $OLD on $(date -u +%Y-%m-%d)."
      docker container inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$OLD" | grep -Ev "$IMAGE_VARS" | grep -v '^$' || true
    } >"$ENV_FILE"
  )
  say "Variables of $OLD written to $ENV_FILE ($(grep -c '^[A-Za-z_]' "$ENV_FILE" || true) variables, not shown)."
fi

# --- … and its key files if they are not in the named volume yet (once)
TAKEN=""
if [ -n "$OLD" ] && [ "$(keys_mount "$OLD")" != "volume $VOLUME" ]; then
  say "Taking over the keys of the existing container $OLD …"
  docker volume create "$VOLUME" >/dev/null
  # Through a pipe straight into the volume, owned by the user of the image; nothing lands on the disk of the host
  docker cp "$OLD:$KEYS_DIR/." - | docker run --rm -i -v "$VOLUME:$KEYS_DIR" --entrypoint tar "$IMAGE" -x -C "$KEYS_DIR" \
    || fail "Could not copy the keys of $OLD into the volume $VOLUME. $OLD keeps running unchanged."
  TAKEN="$(count_keys "$OLD")"
  say "Account keys taken over: $TAKEN."
fi

# --- Settings file: on a new installation with placeholders and an explanation
if [ ! -e "$ENV_FILE" ]; then
  (
    umask 077
    cat >"$ENV_FILE" <<'EOF'
# Variables for Agentio, one NAME=value per line. Remove the # in front of a line to use it.
# After a change run ~/agentio.sh again.
#
# Key from rulio: rulio → AI agent → Connection. More accounts later with
#   docker exec agentio agentio add-key rulio_…
# RULIO_TOKEN=rulio_…
#
# Claude login for runs with Claude Code: create it on your own machine with `claude setup-token`.
# CLAUDE_CODE_OAUTH_TOKEN=…
#
# Only for keys with their own model. Better without a variable, no restart needed:
#   docker exec -it agentio agentio set-provider-key opencode
# OPENCODE_API_KEY=…
# OPENROUTER_API_KEY=…
EOF
  )
  say "Created $ENV_FILE (mode 600) with placeholders: put your rulio key and the Claude token in it, then run ~/agentio.sh again."
fi
chmod 600 "$ENV_FILE"

# --- Replace: the old container steps aside and only goes once the new one runs
STAMP="$(date -u +%Y%m%d%H%M%S)"
ASIDE=""
if [ -n "$OLD" ]; then
  ASIDE="$OLD-previous-$STAMP"
  docker rename "$OLD" "$ASIDE"
  docker stop "$ASIDE" >/dev/null
fi

restore() {
  say "$1" >&2
  docker logs --tail 20 "$NAME" >&2 2>&1 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if [ -n "$ASIDE" ]; then
    docker rename "$ASIDE" "$OLD"
    docker start "$OLD" >/dev/null || true
    say "The previous container $OLD runs again. $ENV_FILE and the volumes are unchanged, nothing was deleted." >&2
  else
    say "$ENV_FILE and the volume $VOLUME are unchanged, nothing was deleted." >&2
  fi
  exit 1
}

docker run -d --name "$NAME" --restart unless-stopped \
  -v "$VOLUME:$KEYS_DIR" \
  --env-file "$ENV_FILE" \
  "$IMAGE" >/dev/null || restore "agentio.sh: the new container could not be created."

sleep "$WAIT"
STATE="$(docker container inspect --format '{{.State.Running}} {{.State.Restarting}}' "$NAME" 2>/dev/null || true)"
[ "$STATE" = "true false" ] || restore "agentio.sh: the new container does not run (it stops or keeps restarting)."
STATUS="$(docker exec "$NAME" agentio status 2>&1)" || restore "agentio.sh: the new container does not answer \`agentio status\`."
if [ -n "$TAKEN" ] && [ "$TAKEN" -gt 0 ] && printf '%s\n' "$STATUS" | grep -q '^Accounts: *no key'; then
  restore "agentio.sh: the new container reports no keys, although $TAKEN were taken over."
fi

# --- Done: the old container can go, its volume stays
if [ -n "$ASIDE" ]; then
  docker rm "$ASIDE" >/dev/null
  say "Removed the previous container $OLD. Its volume stays."
fi
say "Agentio runs as the container $NAME (image $IMAGE, volume $VOLUME, settings $ENV_FILE)."
say ""
printf '%s\n' "$STATUS"
