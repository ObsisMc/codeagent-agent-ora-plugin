# ora-space.codeagent

An **agent plugin** for Ora that publishes **CodeAgent** as a selectable agent.
The plugin runs `codeagent acp` (CodeAgent's
[Agent Client Protocol](https://agentclientprotocol.com) mode) as a child
process and bridges it to Ora as a pure ACP pipe.

Nothing in Ora is hardcoded for this plugin: it is discovered from the installed
plugin directory, validated from `orax.toml`, and launched as an ordinary agent
provider. Deleting the directory removes the agent.

```
┌────────────────────────── Ora host (Rust) ───────────────────────────┐
│  agent_runtime → plugin_agent                                        │
│    invoke : agent/start · agent/stop · agent/listModels              │
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

| Host requirement                     | Implementation                                                            |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `ora/register` with methods + emits  | `runAgentPlugin` → SDK `defineAgent`: 3 methods, `agent/acp` emit         |
| `agent/start`                        | `handlers/lifecycle.ts` spawns `codeagent acp` with the host cwd          |
| `agent/stop`                         | kills the CLI, keeps this process alive so a later start can respawn it   |
| `agent/listModels`                   | `handlers/models.ts`: `codeagent models`, cached, single-default fallback |
| `agent/acp` (both directions)        | `handlers/acp.ts` + `services/codeagent-client.ts`, payload never parsed  |
| CLI absent → `-32001`                | `services/command.ts` throws `PluginMethodError(AGENT_NOT_INSTALLED, …)`  |
| one plugin = one agent = one process | a single plugin instance owning a single `CodeAgentClient`                |

## Resolving the CLI

`codeagent` is looked up on PATH. Windows installers disagree on what they put
there, so three spellings are tried in order:

| Order | Candidate       | Comes from                                     |
| ----- | --------------- | ---------------------------------------------- |
| 1     | `codeagent.exe` | a native install (scoop, choco, standalone)    |
| 2     | `codeagent.cmd` | the batch shim npm and bun write for a package |
| 3     | `codeagent`     | an extensionless launcher                      |

The `.exe` goes first deliberately. A `.cmd` shim runs under `cmd.exe`, so the
process this plugin holds a handle to is the shim, not the CLI — killing it on
`agent/stop` can leave the real child running. `stop()` closes stdin before the
kill for the same reason, giving a CLI that exits on EOF the chance to shut
itself down cleanly.

Non-Windows platforms only try `codeagent`.

Set `ORA_CODEAGENT_BIN` to a full path to skip PATH resolution entirely. A pin
is used alone and never falls back, because silently running a different CLI
than the one the user named is worse than failing.

The working directory is set as the child process's own `cwd` rather than passed
as a flag, so this does not depend on how the CLI spells its working-directory
option. Per-session directories travel in ACP `session/new`, which this plugin
passes through untouched.

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
package.json                 Ora plugin manifest (ora.id, engines, contributes)
orax.toml                    packaging metadata read by the release workflow
deno.json                    developer tasks and the import map
src/
  main.ts                    entrypoint: mounts handlers onto the base class
  base/agent-plugin.ts       AgentPlugin base class + dispatch + runAgentPlugin
  handlers/
    lifecycle.ts             agent/start, agent/stop
    models.ts                agent/listModels
    acp.ts                   agent/acp (host → CLI)
  services/
    codeagent-client.ts      spawns and owns `codeagent acp`, both stdio pumps
    command.ts               binary resolution, spawn candidates, not-found mapping
    ndjson.ts                NDJSON line codec for the CLI's stdio
tests/
  main_test.ts               unit tests for CLI resolution and NDJSON framing
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
`--allow-run --allow-read --allow-env --allow-net`; this plugin needs all four
(spawn the CLI, resolve it, read `ORA_CODEAGENT_BIN`, let the CLI reach its
providers).

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

Tagging `v*` builds that bundle and publishes `ora-space.codeagent-<tag>.orax` —
a flat zip of `orax.toml`, `dist/main.js`, `logo.svg`, and `README.md` — to a
GitHub release.

`deno task simulate` speaks Ora's binary frame protocol to a freshly launched
plugin process:

```
ok: register {"methods":["agent/start","agent/stop","agent/listModels"],"emits":["agent/acp"]}
ok: agent/start {"protocol":"acp","acpVersion":1}
ok: initialize {"protocolVersion":1,"agentCapabilities":{…}}
ok: session/new {"sessionId":"ses_…"}
[host] << {"method":"agent/acp",…}          # streamed session/update forwarded back
ok: listModels 1 models, first {"id":"default",…}
ok: agent/stop
plugin exited with code 0
```

## Known limits

- `agent/start` receives the host's home directory as `cwd`; per-session working
  directories travel in ACP `session/new`, which this plugin passes through.
- The model list is cached for the process lifetime, so models that appear after
  a provider login need a plugin restart. If `codeagent models` does not exist
  or prints something other than one model id per line, the picker falls back to
  a single `default` entry and the CLI picks the model from its own config.
- When the CLI exits on its own the plugin logs it and lets the host observe a
  stalled connection; the contract has no `agent/exited` notification yet.
- Killing the CLI on `agent/stop` is best effort; Ora retains process-tree
  reaping.
- Neither manifest declares permissions. The plugin needs `--allow-run` to spawn
  the CLI, `--allow-read`/`--allow-env` to resolve it (PATH and
  `ORA_CODEAGENT_BIN`), and `--allow-net` for the CLI's providers, but it relies
  on the flags Ora grants agent plugins today: the model in `ora-space/specs`
  (`permissions.process`) is not the schema orax accepts, and orax rejects
  unknown fields, so the declaration waits for the host to ship it.

## License

Apache-2.0
