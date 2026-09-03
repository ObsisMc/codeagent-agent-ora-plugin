# ora-space.codeagent

An Ora **agent plugin**: a Deno process that speaks Ora's binary JSON-RPC
protocol on stdio and bridges `codeagent acp` to Ora as an ACP pipe. `README.md`
describes what it does; this file records the constraints that are easy to get
wrong and expensive to rediscover.

## This is an agent plugin, and an agent plugin implements the whole SDK contract

**`kind = "agent"` in `orax.toml` is not a label — it is a contract, and a
partial implementation of it fails silently rather than loudly.** Ora validates
the registration handshake and then simply does not use what a plugin did not
declare. There is no warning, no log line, and no error surfaced to the user.

Every API the plugin SDK offers an agent must be served, not just the ones a
feature currently exercises:

| SDK surface                                                                                                                             | Where it is mounted                                     | What is lost by omitting it                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `agent/start` · `agent/stop`                                                                                                            | `handlers/lifecycle.ts`                                 | the agent cannot run at all — these are `abstract`, so this fails to compile |
| `agent/list_models`                                                                                                                     | `handlers/models.ts`                                    | no model picker; also `abstract`                                             |
| `agent/acp` (both directions)                                                                                                           | `handlers/acp.ts` + `services/codeagent-client.ts`      | no conversation; also `abstract`                                             |
| **Effect Resources** — `effect/coordinate`, `effect/reactivate`, `effect/verify_ready`, and the `EffectResourceDeclaration` behind them | `handlers/effects.ts`, mounted as `AgentPlugin.effects` | **Skills never appear in the Workspace, with no error anywhere**             |

The Effect row is the one that has actually been shipped broken. Read the next
section before touching anything about Skills.

## Effects are opt-in, and opting out is invisible

The Skill directory Ora writes into a Workspace exists **only** because this
plugin declares it. The chain is short and every link is a hard gate:

```
handlers/effects.ts  SKILLS_RESOURCE                    ← the declaration
main.ts              override readonly effects = …      ← mounted on the instance
base/agent-plugin.ts defineAgent({ …, effects })        ← handed to the SDK
SDK agent.ts         if (effects !== undefined) { declareEffectResource(…) }
SDK plugin.ts        effectResources omitted from ora/register when the list is empty
```

Miss **any** of those and `ora/register` goes out with no `effectResources`
field at all. From Ora's side that plugin does not consume Skills, so:

- importing a Skill succeeds,
- Ora has no Target to project it onto,
- nothing is ever written to disk,
- and no error is raised, logged, or shown.

This is what "codeagent doesn't materialize skills but opencode does" was: the
same code in both plugins except `handlers/effects.ts` and its three lines of
wiring, which codeagent never had. **When a Skill does not appear, check the
declaration before debugging materialization.** The shipped bundle answers it in
one command:

```
deno task build && grep -c skill dist/main.js
```

A `0` means the declaration never reached the package.

### What the coordination calls have to promise

Declaring a Resource is also a promise to make its mutation safe, and Ora will
call all three methods:

- **`coordinate`** must raise the new-turn barrier _before_ it waits for running
  turns, not after. A check that only latched on an observed idle moment would
  never find one in a Workspace whose prompts keep arriving; holding first makes
  the set of turns to drain finite, so the wait terminates. It must also release
  the barrier before failing — Ora only reactivates Targets whose coordination
  succeeded, so an abandoned barrier holds its queued prompts for the life of
  the process.
- **`reactivate`** respawns the CLI. Restarting is deliberately chosen over
  modelling when CodeAgent rereads its Skill directory: a restart is correct
  whether the CLI scans once at startup or resolves per session.
- **`verify_ready`** reports readiness by **returning**; a Consumer says "not
  ready" by throwing. Returning a payload that says "not ready" would be
  recorded as ready.
- **Both coordination calls must be idempotent.** Ora retries them. The held
  frame queue is the marker: a repeat `reactivate` finds nothing held — the
  state a finished reactivation leaves behind — and must not restart a CLI that
  already rescanned, which would tear down the sessions that came back from the
  first restart.

`SKILLS_RESOURCE.workspaceRelativePath` is `.cac/skills` — CodeAgent's own
directory, and note it is `.cac`, not `.codeagent`. Do not "correct" it to match
the CLI's name or the plugin's. It is also deliberately not a shared directory
like `.claude/skills`: Ora fully owns what it materializes into a declared
Resource, so declaring a shared one would have Ora reconcile away Skills another
tool put there.

## Resolving the CLI on Windows — always include `.bat`

**Every list of PATH spellings for a CLI must name `.bat`, `.exe`, `.cmd`, and
the bare name.** This has broken real installs more than once, always the same
way, and it is the single most important rule in this file after the one above.

```ts
return Deno.build.os === "windows"
  ? [
    `${BINARY_NAME}.bat`,
    `${BINARY_NAME}.exe`,
    `${BINARY_NAME}.cmd`,
    BINARY_NAME,
  ]
  : [BINARY_NAME];
```

Why each part matters:

- **The host's PATH lookup only appends `.exe` to a bare name.** It does not try
  `.cmd` or `.bat`. So naming just `codeagent` finds nothing on a machine where
  the CLI is installed as a shim — which is what npm, bun, and many installers
  actually write.
- **Omitting a spelling is indistinguishable from "not installed".** The ladder
  in `spawnAgentProcess` only advances on `program_not_found`, so a missing
  spelling exhausts the list and raises `AGENT_NOT_INSTALLED` (`-32001`).
- **That failure surfaces as something unrelated.** Ora deliberately suppresses
  the log for `AgentNotInstalled` (`connection.rs`, "would flood the runtime
  log"), then tears the plugin process down — so the only thing the user sees is
  `plugin stdout closed` from the plugin runtime's stdout reader. Nothing in
  that message mentions PATH, the CLI, or the spelling that was missed. **Do not
  spend time debugging the plugin when you see `plugin stdout closed`; check the
  candidate list first.**

Adding a spelling is free: only "this one is not on PATH" advances to the next
candidate, and a candidate that resolved and then failed is raised as-is rather
than being buried under the next attempt. There is no downside to listing one
that no installer produces, and a real cost to omitting one that does.

### Why `.bat` leads here, against `PATHEXT`

Windows' own `PATHEXT` precedence puts `.exe` first, and sibling plugins order
their lists that way. This one does not: CodeAgent is distributed as a batch
wrapper, so `.bat` is the spelling a real install answers to, and leading with
it costs one host round trip instead of three misses before it — every miss is a
full `ora/childprocess/spawn` round trip over the stdio pipe, on a path
(`agent/list_models`) that is already the slowest thing this plugin does.

The tradeoff is real and worth restating before anyone "fixes" the order back: a
`.bat` runs under `cmd.exe`, so on a machine carrying both a wrapper and a
native binary the handle the host holds is the wrapper, not the CLI. That is
survivable because `stop()` closes stdin before killing and the host's kill is
tree-wide, and a user who wants the native binary held directly can name it with
`ORA_CODEAGENT_BIN`. **Order is a performance choice; coverage is a correctness
one.** Reorder freely, but never drop a spelling.

## Process ownership

Every subprocess goes through the host: `createHostProcesses(plugin)` →
`ora/childprocess/spawn`. Never `Deno.Command`. The host owns the OS handle,
terminates process trees, and reclaims whatever a plugin generation left behind
— none of which a sandboxed plugin can promise, least of all through a Windows
shim whose real child outlives a kill of the wrapper.

## Model discovery

`agent/list_models` receives the workspace `cwd` and answers it by running a
**separate, one-shot** `codeagent acp`, not by borrowing the connection Ora
holds:

- A request injected into Ora's connection returns its answer down Ora's pipe.
- Ora's own `initialize` declares the client capability that decides whether the
  agent reports a model selector at all, and discovery runs before that.

The probe declares `clientCapabilities: { session: { configOptions: {} } }` —
without it the agent reports no model selector. Answers are cached per workspace
for five minutes; a failure is never cached.

**Discovery is the slowest path in this plugin, and it is slow by
construction.** CodeAgent publishes no pre-session model list, so every cache
miss pays a CLI cold start plus a full `initialize` → `session/new` handshake,
inside a 40-second probe budget. This plugin ships no bundled binary, so it also
pays PATH resolution first. When someone reports "the model list takes 30
seconds", the time is in the CLI, not in this plugin — check the
`[codeagent:probe]` stderr lines for where between spawn and `session/new` it
goes. The levers available here are the candidate order above and
`ORA_CODEAGENT_BIN`; the rest belongs to the CLI.

Note that `onStart` and `onStop` both invalidate the catalog for their `cwd`, so
a start/stop cycle around a picker opening makes the next open pay full price.

## Protocol hygiene

- **stdout is the binary protocol channel.** `protectProtocolStdout()` redirects
  every `console` method to stderr before any plugin code runs. A single
  `console.log` reaching stdout is read by the host as a corrupt frame and takes
  the plugin down.
- **ACP payloads are never parsed** on the bridge. Frames are re-framed between
  Ora's binary envelope and the CLI's NDJSON and otherwise passed through
  verbatim. `handlers/effects.ts` is the one exception, and a deliberately
  narrow one: it reads `method` and `id` off the envelope to track turns, and
  never looks at `params`.
- **Throw the right error code.** `AGENT_NOT_INSTALLED` (`-32001`) is retried
  quietly by Ora as expected local configuration; `AGENT_UNUSABLE` (`-32002`) is
  reported once and not retried; `-32000` is how an Effect Consumer says "not
  ready right now". Use `AGENT_UNUSABLE` only when the CLI this package ships
  cannot run at all.

## Manifest

`orax.toml` is the manifest Ora reads. There is no `package.json` — it was a
legacy Ora manifest that no release has ever read, and its `engines.ora` field
held a plugin **SDK** version in a **host** version field. If a host requirement
ever needs declaring, it goes in `orax.toml`:

```toml
[dependencies]
ora = ">= x.y.z"
```

Ora parses and validates that table today but does not yet enforce it, and the
host version is not the SDK version — do not fill it with an SDK number.

## Working on this repository

- `deno task check` / `lint` / `format` / `test` / `simulate` / `build`.
- The SDK is imported from its published JSR package and pinned in `deno.json`;
  keep `deno.lock` synchronized when changing the SDK version.
- `deno task test` needs no CLI: discovery is exercised against a fake
  `HostProcesses` that scripts an ACP peer, and effect coordination against a
  `CodeAgentClient` with a scripted `spawn`. `deno task simulate` needs a real
  `codeagent` on PATH.
- One test reads `src/main.ts` as text to assert the effect wiring is present.
  That is deliberate: the entrypoint calls `runAgentPlugin` at module scope, so
  importing it would start serving the host, and the wiring it guards is exactly
  the kind whose absence is invisible at runtime.
- Bump `orax.toml` `version` before handing someone a `.orax` to import.
  `install_local` refuses a version that is already installed and never retires
  older ones, so reusing a number silently leaves the old code running.
