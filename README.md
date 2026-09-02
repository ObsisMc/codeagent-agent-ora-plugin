# ora-space.codeagent

An **agent plugin** for Ora that publishes **CodeAgent** as a selectable agent.
The plugin runs `codeagent acp` (CodeAgent's
[Agent Client Protocol](https://agentclientprotocol.com) mode) and bridges it to
Ora as a pure ACP pipe. The process itself is spawned and owned by the host
through `ora/childprocess/*`, so Ora reaps it with this plugin generation
however that generation ends.

Nothing in Ora is hardcoded for this plugin: it is discovered from the installed
plugin directory, validated from `orax.toml`, and launched as an ordinary agent
provider. Deleting the directory removes the agent.

```
┌────────────────────────── Ora host (Rust) ───────────────────────────┐
│  agent_runtime → plugin_agent                                        │
│    invoke : agent/start · agent/stop · agent/list_models             │
│    notify : agent/acp (bidirectional, payload never parsed)          │
└────────────────────────────┬─────────────────────────────────────────┘
                             │ stdio, 4-byte length + 0x01 + JSON-RPC
                             v
┌──────────────────── this plugin (Deno process) ──────────────────────┐
│  src/main.ts        CodeAgentPlugin extends AgentPlugin              │
│  src/handlers/*     one module per registered API                    │
│  src/services/*     CodeAgent CLI ownership, NDJSON framing          │
└────────────────────────────┬─────────────────────────────────────────┘
                             │ NDJSON, one JSON-RPC object per line
                             v
                     codeagent acp (ACP protocolVersion 1)
```

## Contract mapping

| Host requirement                     | Implementation                                                           |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `ora/register` with methods + emits  | `runAgentPlugin` → SDK `defineAgent`: 3 methods, `agent/acp` emit        |
| `agent/start`                        | `handlers/lifecycle.ts` spawns `codeagent acp` with the host cwd         |
| `agent/stop`                         | kills the CLI, keeps this process alive so a later start can respawn it  |
| `agent/list_models`                  | `handlers/models.ts` probes a throwaway ACP session for the workspace    |
| `agent/acp` (both directions)        | `handlers/acp.ts` + `services/codeagent-client.ts`, payload never parsed |
| CLI absent → `-32001`                | `services/command.ts` throws `PluginMethodError(AGENT_NOT_INSTALLED, …)` |
| every subprocess is host-owned       | `createHostProcesses` → `ora/childprocess/*`, never `Deno.Command`       |
| one plugin = one agent = one process | a single plugin instance owning a single `CodeAgentClient`               |

## Resolving the CLI

`codeagent` is looked up on PATH — by the host, which owns the resulting
process. Windows installers disagree on what they put there, so four spellings
are tried in order, following Windows' own `PATHEXT` precedence:

| Order | Candidate       | Comes from                                     |
| ----- | --------------- | ---------------------------------------------- |
| 1     | `codeagent.exe` | a native install (scoop, choco, standalone)    |
| 2     | `codeagent.cmd` | the batch shim npm and bun write for a package |
| 3     | `codeagent.bat` | an installer or hand-written batch wrapper     |
| 4     | `codeagent`     | an extensionless launcher                      |

The `.exe` goes first deliberately: a `.cmd` or `.bat` wrapper runs under
`cmd.exe`, so the process resolved from it is the wrapper rather than the CLI.
`stop()` closes stdin before the kill for the same reason, giving a CLI that
exits on EOF the chance to shut itself down cleanly — though the host's own kill
is tree-wide, so a shim's real child no longer survives it.

Only the spelling that is missing from PATH moves on to the next candidate. One
that resolved and then failed is a real fault and is raised as-is, so it is
never buried under the next attempt.

Non-Windows platforms only try `codeagent`.

Set `ORA_CODEAGENT_BIN` to a full path to skip PATH resolution entirely. A pin
is used alone and never falls back, because silently running a different CLI
than the one the user named is worse than failing.

The working directory is set as the child process's own `cwd` rather than passed
as a flag, so this does not depend on how the CLI spells its working-directory
option. Per-session directories travel in ACP `session/new`, which this plugin
passes through untouched.

## Model discovery

CodeAgent publishes its model choices in one place: the `configOptions` an ACP
session carries. There is no pre-session listing to read, so when Ora asks this
plugin which models a workspace offers, the plugin starts a second, throwaway
`codeagent acp` in that directory, runs `initialize` → `session/new` on it,
reads the model selector out of the answer, deletes the probe session if the CLI
says it can, and kills the process. The pre-session list and the in-session
picker are therefore two readings of one source rather than two sources that can
disagree.

It has to be a separate process. The connection Ora holds is one Ora owns both
ends of: a request injected into it would return its answer down Ora's pipe, and
the client capabilities Ora declares in its own `initialize` are what decide
whether CodeAgent reports a model selector at all. It also has to be a process
the host spawns — discovery is the likeliest thing to fail halfway, and a
failure outside the host's ownership leaves an orphan CLI behind.

Answers are reused for a minute per workspace, so a picker that re-renders does
not restart the CLI. An agent that exposes no model selector yields an empty
list, which Ora accepts: its models then arrive with the session instead.

## API registration architecture

Every registered API is a method on a base class, and the entrypoint only mounts
handler modules onto it.

- `src/base/agent-plugin.ts` declares `abstract class AgentPlugin`. Required
  APIs are `abstract`, so an incomplete plugin fails to compile; optional APIs
  (`onStop`, `onActivate`, `onDeactivate`) ship default implementations.
- `runAgentPlugin` flattens the instance into a wire-name keyed dispatch table
  by walking its prototype chain, so dispatch is a single map lookup and a
  handler mounted as a field (`override onStart = …`) is found exactly like a
  method.
- `AGENT_METHOD_ROUTES` / `AGENT_NOTIFICATION_ROUTES` hold the class-method →
  JSON-RPC name mapping explicitly, because the host contract fixes the wire
  names and deriving them from method names would silently break on a rename.
- Adding an API later means adding one method to the base class, one route
  entry, and one handler module — the entrypoint does not grow.

## Layout

```
orax.toml                    the plugin manifest Ora reads: identity, kind, version
deno.json                    developer tasks and the import map
src/
  main.ts                    entrypoint: mounts handlers onto the base class
  base/agent-plugin.ts       AgentPlugin base class + dispatch + runAgentPlugin
  handlers/
    lifecycle.ts             agent/start, agent/stop
    models.ts                agent/list_models
    acp.ts                   agent/acp (host → CLI)
  services/
    codeagent-client.ts      owns the live `codeagent acp`, both stdio pumps
    acp-probe.ts             one short-lived ACP conversation, for discovery
    command.ts               which program the host is asked to spawn, and how a miss is classified
    ndjson.ts                NDJSON line codec for the CLI's stdio
tests/
  main_test.ts               unit tests for discovery, CLI resolution, NDJSON framing
  host-simulator.ts          drives this plugin the way the Ora host does
```

The SDK is imported as the bare specifier `@ora-space/plugin-sdk`, mapped in
`deno.json`. What Ora installs is `dist/main.js`, where `deno task build` has
already inlined the SDK, so no import map has to survive into the installed
package.

## Requirements

- The CodeAgent CLI on PATH, or `ORA_CODEAGENT_BIN` pointing at it.
- Deno, which Ora provides for plugin processes.

Ora launches agent plugins with
`--allow-run --allow-read --allow-env --allow-net`. This plugin no longer needs
`--allow-run` of its own — every process it uses is spawned by the host through
`ora/childprocess/*` — but it still reads `ORA_CODEAGENT_BIN` from the
environment, and the CLI the host starts on its behalf reaches its providers
over the network.

### Host requirement

This plugin needs an Ora that sends the workspace `cwd` with
`agent/list_models`. Without it there is no directory to discover models for,
and the plugin answers `-32602` naming the missing parameter rather than probing
against nothing.

That requirement is deliberately **not** declared in `orax.toml`, even though
the schema has the right field for it:

```toml
[dependencies]
ora = ">= x.y.z"
```

Ora parses and validates that table (only `ora` is accepted in it), so it is
where a host requirement belongs — but the host version carrying the parameter
does not exist yet. Ora is at 0.1.0 and the parameter is an unreleased change,
so any number written here today would either be false or vacuous, and a
requirement no host satisfies would make the plugin uninstallable the moment Ora
starts enforcing the field. Fill it in once there is a real host version to
name.

Note that the plugin SDK's version and Ora's are separate lines. This plugin
builds against SDK 0.9.0; that is not an Ora version. The `package.json` this
repository used to carry declared `engines.ora >= 0.8.0` — an SDK version in a
host-version field, in a file no Ora release has ever read: shipped `.orax`
packages contain only `orax.toml`, `main.js`, `logo.svg`, and `README.md`. It
has been removed rather than corrected.

## Install

Search for **CodeAgent** in Ora's plugin marketplace, or install it from a local
checkout:

```
orax install --path .
```

## Verification

```
deno task check      # type check
deno task test       # unit tests, no CLI required
deno task simulate   # full host handshake against a real CodeAgent CLI
deno task build      # bundle to dist/main.js
```

Tagging `v*` builds that bundle and publishes two release assets:

- `ora-space.codeagent-<tag>.orax`, a universal flat zip of `orax.toml`,
  `dist/main.js`, `logo.svg`, and `README.md`.
- `manifest.toml`, the marketplace form of `orax.toml`, with top-level `url` and
  `sha256` fields pointing to and verifying that universal archive.

`deno task simulate` speaks Ora's binary frame protocol to a freshly launched
plugin process:

```
ok: register {"methods":["agent/start","agent/stop","agent/list_models"],"emits":["agent/acp"]}
ok: agent/start {"protocol":"acp","acpVersion":1}
ok: initialize {"protocolVersion":1,"agentCapabilities":{…}}
ok: session/new ses_… models via ACP: […]
[host] << {"method":"agent/acp",…}          # streamed session/update forwarded back
ok: list_models 4 models via a probe session, first {"id":…}
ok: agent/stop
plugin exited with code 0
```

## Known limits

- `agent/start` receives the host's home directory as `cwd`; per-session working
  directories travel in ACP `session/new`, which this plugin passes through.
- Discovering the pre-session model list starts a whole CLI and creates one
  session, so an agent that persists its sessions collects one empty
  conversation per probe unless it serves `session/delete`. The one-minute
  per-workspace cache is what keeps that count down.
- A model the user gains mid-session — a new provider login, an edited config —
  reaches the pre-session picker only after that cache window expires. The
  in-session picker is unaffected: it reads the live session's `configOptions`.
- When the CLI exits on its own the plugin logs it and lets the host observe a
  stalled connection; the contract has no `agent/exited` notification yet.
- Killing the CLI on `agent/stop` is best effort; Ora retains process-tree
  reaping.
- Neither manifest declares permissions. The plugin relies on the flags Ora
  grants agent plugins today: the model in `ora-space/specs`
  (`permissions.process`) is not the schema orax accepts, and orax rejects
  unknown fields, so the declaration waits for the host to ship it.

## License

Apache-2.0
