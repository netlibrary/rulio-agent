import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * scripts/agentio.sh (rulio-tickets#946) against a made-up `docker`: containers, volumes and
 * calls live as files in a folder, volumes are real folders, copies run through real `tar`.
 * Only made-up keys.
 */
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "agentio.sh");
const KEYS_DIR = "/home/agent/.rulio-agent";
const KEYS = ["rulio_erfundenaaaaaaaaaaaaaaaaaaaaaAAAAAA", "rulio_erfundenbbbbbbbbbbbbbbbbbbbbbBBBBBB", "rulio_erfundenccccccccccccccccccccccCCCCCC"];
const CLAUDE = "sk-ant-oat01-erfunden-claude-token-123";
const ZEN = "zen-erfunden-anbieter-schluessel-456";
const PROVIDER_FILE = "OPENROUTER_API_KEY=or-erfunden-aus-der-datei-789\n";
const SECRETS = [...KEYS, CLAUDE, ZEN, "or-erfunden-aus-der-datei-789"];

const FAKE = String.raw`
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const dir = process.env.FAKE_DOCKER_STATE;
const file = join(dir, "state.json");
const st = JSON.parse(readFileSync(file, "utf8"));
const args = process.argv.slice(2);
st.calls.push(args.join(" "));
const save = () => writeFileSync(file, JSON.stringify(st, null, 2));
const out = (s) => process.stdout.write(s);
const die = (msg, code = 1) => { save(); process.stderr.write(msg + "\n"); process.exit(code); };
const vol = (name) => join(dir, "volumes", name);
const keysDirOf = (c) => { const m = c.mounts.find((m) => m.dest === "${KEYS_DIR}"); return m ? vol(m.name) : join(dir, "fs", c.name); };
const [cmd, ...rest] = args;
if (cmd === "container" && rest[0] === "inspect") {
  const format = rest[2];
  const c = st.containers[rest[3]];
  if (!c) die("Error: No such container: " + rest[3]);
  if (format.includes(".Mounts")) { const m = c.mounts.find((m) => m.dest === "${KEYS_DIR}"); out(m ? m.type + " " + m.name + "\n" : "\n"); }
  else if (format.includes(".Config.Env")) out(c.env.map((e) => e + "\n").join("") + "\n");
  else if (format.includes(".State.Running")) out(c.running + " " + c.restarting + "\n");
  else out("/" + c.name + "\n");
} else if (cmd === "pull") {
  if (process.env.FAKE_PULL_FAIL) die("pull failed");
  st.pulls++;
} else if (cmd === "volume" && rest[0] === "create") {
  mkdirSync(vol(rest[1]), { recursive: true });
  st.volumes[rest[1]] = true;
  out(rest[1] + "\n");
} else if (cmd === "cp") {
  const [name] = rest[0].split(":");
  const c = st.containers[name];
  if (!c) die("Error: No such container: " + name);
  const from = keysDirOf(c);
  mkdirSync(from, { recursive: true });
  const t = spawnSync("tar", ["-cf", "-", "."], { cwd: from });
  process.stdout.write(t.stdout);
} else if (cmd === "run") {
  const i = (flag) => rest.indexOf(flag);
  const mounts = [];
  rest.forEach((a, n) => { if (rest[n - 1] === "-v") { const [name, dest] = a.split(":"); mounts.push({ type: "volume", name, dest }); } });
  if (rest.includes("--rm")) {
    // Helper: tar into the volume
    const target = vol(mounts[0].name);
    mkdirSync(target, { recursive: true });
    const input = readFileSync(0);
    const t = spawnSync("tar", ["-xf", "-"], { cwd: target, input });
    if (t.status !== 0) die("tar failed");
  } else {
    const name = rest[i("--name") + 1];
    if (st.containers[name]) die("Conflict: name " + name + " in use", 125);
    const envFile = rest[i("--env-file") + 1];
    const env = readFileSync(envFile, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="));
    const broken = !!process.env.FAKE_NEW_BROKEN;
    for (const m of mounts) { mkdirSync(vol(m.name), { recursive: true }); st.volumes[m.name] = true; }
    st.containers[name] = { name, image: rest[rest.length - 1], env, mounts, running: !broken, restarting: broken, restart: rest[i("--restart") + 1] };
    out("abc123\n");
  }
} else if (cmd === "rename") {
  const c = st.containers[rest[0]];
  if (!c) die("No such container");
  delete st.containers[rest[0]];
  c.name = rest[1];
  if (existsSync(join(dir, "fs", rest[0]))) spawnSync("mv", [join(dir, "fs", rest[0]), join(dir, "fs", rest[1])]);
  st.containers[rest[1]] = c;
} else if (cmd === "stop" || cmd === "start") {
  const c = st.containers[rest[0]];
  if (!c) die("No such container");
  c.running = cmd === "start";
  c.restarting = false;
} else if (cmd === "rm") {
  const name = rest[rest.length - 1];
  if (!st.containers[name]) die("No such container");
  delete st.containers[name];
} else if (cmd === "logs") {
  out("log line\n");
} else if (cmd === "exec") {
  const c = st.containers[rest[0]];
  if (!c || !c.running) die("container not running");
  const keysFile = join(keysDirOf(c), "keys");
  const keys = existsSync(keysFile) ? readFileSync(keysFile, "utf8").split("\n").filter((l) => l.startsWith("rulio_")) : [];
  const token = c.env.find((e) => e.startsWith("RULIO_TOKEN="));
  if (token) keys.unshift(token.slice(12));
  out("Accounts:    " + (keys.length ? keys.length + " keys (" + keys.map((k) => "…" + k.slice(-6)).join(", ") + ")" : "no key") + "\n");
  out("Providers:   opencode " + (c.env.some((e) => e.startsWith("OPENCODE_API_KEY=")) ? "set (variable)" : "not set") + "\n");
} else die("fake docker: unknown " + args.join(" "));
save();
`;

interface Container {
  name: string;
  image: string;
  env: string[];
  mounts: Array<{ type: string; name: string; dest: string }>;
  running: boolean;
  restarting: boolean;
  restart?: string;
}
interface State {
  containers: Record<string, Container>;
  volumes: Record<string, boolean>;
  pulls: number;
  calls: string[];
}

function setup(state: Partial<State> = {}) {
  const root = mkdtempSync(join(tmpdir(), "agentio-sh-"));
  const bin = join(root, "bin");
  const docker = join(root, "docker");
  const home = join(root, "home");
  mkdirSync(bin);
  mkdirSync(join(docker, "volumes"), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(docker, "fake.mjs"), FAKE);
  const unix = (p: string) => p.replace(/\\/g, "/");
  writeFileSync(join(bin, "docker"), `#!/bin/sh\nexec "${unix(process.execPath)}" "${unix(join(docker, "fake.mjs"))}" "$@"\n`);
  chmodSync(join(bin, "docker"), 0o755);
  writeFileSync(join(docker, "state.json"), JSON.stringify({ containers: {}, volumes: {}, pulls: 0, calls: [], ...state }));
  const run = (env: NodeJS.ProcessEnv = {}) => {
    const r = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: home, AGENTIO_WAIT: "0", FAKE_DOCKER_STATE: docker, ...env },
    });
    return { code: r.status, text: `${r.stdout}${r.stderr}` };
  };
  const read = (): State => JSON.parse(readFileSync(join(docker, "state.json"), "utf8"));
  return { root, docker, home, envFile: join(home, "agentio.env"), run, read, volume: (name: string) => join(docker, "volumes", name) };
}

const noSecrets = (text: string) => {
  for (const s of SECRETS) assert.ok(!text.includes(s), "the script printed a key");
};
const neverDeletesVolumes = (s: State) => {
  assert.ok(!s.calls.some((c) => /^volume (rm|remove|prune)/.test(c) || /^rm (.* )?-v/.test(c) || /^rm -fv/.test(c)), s.calls.join("\n"));
};

test("new installation: settings file with placeholders (mode 600), container agentio with the named volume", () => {
  const t = setup();
  const r = t.run();
  assert.equal(r.code, 0, r.text);
  const env = readFileSync(t.envFile, "utf8");
  assert.match(env, /^# RULIO_TOKEN=rulio_…$/m);
  assert.match(env, /^# CLAUDE_CODE_OAUTH_TOKEN=…$/m);
  assert.match(env, /set-provider-key opencode/);
  if (process.platform !== "win32") assert.equal(statSync(t.envFile).mode & 0o777, 0o600);
  assert.match(r.text, /Created .*agentio\.env \(mode 600\) with placeholders/);
  const s = t.read();
  const c = s.containers.agentio!;
  assert.equal(c.image, "ghcr.io/netlibrary/rulio-agent:latest");
  assert.equal(c.restart, "unless-stopped");
  assert.deepEqual(c.mounts, [{ type: "volume", name: "agentio-keys", dest: KEYS_DIR }]);
  assert.deepEqual(c.env, []);
  assert.equal(s.pulls, 1);
  assert.match(r.text, /Accounts: {4}no key/);
});

test("existing container with an anonymous volume and 3 keys: variables and keys taken over, the old volume stays, a second run only updates", () => {
  const t = setup({
    containers: {
      "rulio-agent": {
        name: "rulio-agent",
        image: "rulio-agent",
        env: ["PATH=/usr/local/bin:/usr/bin", "NODE_VERSION=22.23.4", "YARN_VERSION=1.22", "RULIO_URL=https://api.rulio.net", `CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE}`, `OPENCODE_API_KEY=${ZEN}`],
        mounts: [{ type: "volume", name: "3f2a9c0d1e", dest: KEYS_DIR }],
        running: true,
        restarting: false,
      },
    },
    volumes: { "3f2a9c0d1e": true },
  });
  mkdirSync(t.volume("3f2a9c0d1e"), { recursive: true });
  writeFileSync(join(t.volume("3f2a9c0d1e"), "keys"), `${KEYS.join("\n")}\n`);
  writeFileSync(join(t.volume("3f2a9c0d1e"), "provider-keys"), PROVIDER_FILE);

  const r = t.run();
  assert.equal(r.code, 0, r.text);
  noSecrets(r.text);
  assert.match(r.text, /Variables of rulio-agent written to .*agentio\.env \(3 variables, not shown\)/);
  assert.match(r.text, /Account keys taken over: 3\./);
  assert.match(r.text, /Removed the previous container rulio-agent\. Its volume stays\./);
  assert.match(r.text, /Accounts: {4}3 keys \(…AAAAAA, …BBBBBB, …CCCCCC\)/);

  const env = readFileSync(t.envFile, "utf8").split("\n").filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(env, ["RULIO_URL=https://api.rulio.net", `CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE}`, `OPENCODE_API_KEY=${ZEN}`]);
  if (process.platform !== "win32") assert.equal(statSync(t.envFile).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(t.volume("agentio-keys"), "keys"), "utf8"), `${KEYS.join("\n")}\n`);
  assert.equal(readFileSync(join(t.volume("agentio-keys"), "provider-keys"), "utf8"), PROVIDER_FILE);
  let s = t.read();
  assert.deepEqual(Object.keys(s.containers), ["agentio"]);
  assert.equal(s.containers.agentio!.running, true);
  assert.deepEqual(s.containers.agentio!.env, env);
  // The old volume is still there, with its keys
  assert.ok(existsSync(join(t.volume("3f2a9c0d1e"), "keys")));
  neverDeletesVolumes(s);

  // Second run: update with the same settings, file and volume unchanged
  const envBefore = readFileSync(t.envFile, "utf8");
  const again = t.run();
  assert.equal(again.code, 0, again.text);
  noSecrets(again.text);
  assert.doesNotMatch(again.text, /taken over|written to/);
  assert.equal(readFileSync(t.envFile, "utf8"), envBefore);
  assert.equal(readFileSync(join(t.volume("agentio-keys"), "keys"), "utf8"), `${KEYS.join("\n")}\n`);
  s = t.read();
  assert.equal(s.pulls, 2);
  assert.deepEqual(Object.keys(s.containers), ["agentio"]);
  assert.deepEqual(s.containers.agentio!.mounts, [{ type: "volume", name: "agentio-keys", dest: KEYS_DIR }]);
  assert.match(again.text, /Accounts: {4}3 keys/);
  neverDeletesVolumes(s);
});

test("the new container does not start: an error, the old one runs again, nothing deleted", () => {
  const t = setup({
    containers: {
      "rulio-agent": {
        name: "rulio-agent",
        image: "rulio-agent",
        env: [`RULIO_TOKEN=${KEYS[0]}`, `CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE}`],
        mounts: [{ type: "volume", name: "anon77", dest: KEYS_DIR }],
        running: true,
        restarting: false,
      },
    },
    volumes: { anon77: true },
  });
  mkdirSync(t.volume("anon77"), { recursive: true });
  writeFileSync(join(t.volume("anon77"), "keys"), `${KEYS[1]}\n`);
  const r = t.run({ FAKE_NEW_BROKEN: "1" });
  assert.equal(r.code, 1, r.text);
  noSecrets(r.text);
  assert.match(r.text, /the new container does not run/);
  assert.match(r.text, /The previous container rulio-agent runs again\. .*agentio\.env and the volumes are unchanged, nothing was deleted\./);
  const s = t.read();
  assert.deepEqual(Object.keys(s.containers), ["rulio-agent"]);
  assert.equal(s.containers["rulio-agent"]!.running, true);
  assert.ok(existsSync(join(t.volume("anon77"), "keys")));
  assert.ok(existsSync(t.envFile));
  neverDeletesVolumes(s);
});

test("the image cannot be fetched: nothing changes", () => {
  const t = setup({
    containers: {
      agentio: { name: "agentio", image: "x", env: ["RULIO_URL=https://api.rulio.net"], mounts: [{ type: "volume", name: "agentio-keys", dest: KEYS_DIR }], running: true, restarting: false },
    },
  });
  const r = t.run({ FAKE_PULL_FAIL: "1" });
  assert.equal(r.code, 1);
  assert.match(r.text, /Could not fetch .* Nothing was changed\./);
  const s = t.read();
  assert.equal(s.containers.agentio!.running, true);
  assert.ok(!existsSync(t.envFile));
  assert.deepEqual(s.calls.filter((c) => !c.startsWith("container inspect")), ["pull --quiet ghcr.io/netlibrary/rulio-agent:latest"]);
});

test("the script prints no value: no echo of variables, no set -x", () => {
  const text = readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(text, /set -[a-z]*x/);
  assert.doesNotMatch(text, /cat "\$ENV_FILE"|printenv|env \|/);
  assert.match(text, /^set -euo pipefail$/m);
  assert.ok(!text.includes("\r"), "LF only, or bash on the server stumbles");
});
