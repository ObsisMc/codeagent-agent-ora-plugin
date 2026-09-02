# ora-space.codeagent

An Ora **agent plugin**: a Deno process that speaks Ora's binary JSON-RPC
protocol on stdio and bridges `codeagent acp` to Ora as an ACP pipe. `README.md`
describes what it does; this file records the constraints that are easy to get
wrong and expensive to rediscover.

## Resolving the CLI on Windows — always include `.bat`

**Every list of PATH spellings for a CLI must name `.exe`, `.cmd`, `.bat`, and
the bare name, in that order.** This has broken real installs more than once,
always the same way, and it is the single most important rule in this file.

```ts
return Deno.build.os === "windows"
  ? [
    `${BINARY_NAME}.exe`,
    `${BINARY_NAME}.cmd`,
    `${BINARY_NAME}.bat`,
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
- **The order is Windows' own `PATHEXT` precedence.** `.exe` first means the
  process the host holds is the CLI itself rather than a `cmd.exe` wrapper
  around it, which matters when the host kills it.

Adding a spelling is free: only "this one is not on PATH" advances to the next
candidate, and a candidate that resolved and then failed is raised as-is rather
than being buried under the next attempt. There is no downside to listing one
that no installer produces, and a real cost to omitting one that does.

The same list exists in every sibling plugin (`opencode-agent`,
`claude-code-agent`, `codex-agent`). When you touch one, check the others still
match.

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
for a minute; a failure is never cached.

## Protocol hygiene

- **stdout is the binary protocol channel.** `protectProtocolStdout()` redirects
  every `console` method to stderr before any plugin code runs. A single
  `console.log` reaching stdout is read by the host as a corrupt frame and takes
  the plugin down.
- **ACP payloads are never parsed** on the bridge. Frames are re-framed between
  Ora's binary envelope and the CLI's NDJSON and otherwise passed through
  verbatim.
- **Throw the right error code.** `AGENT_NOT_INSTALLED` (`-32001`) is retried
  quietly by Ora as expected local configuration; `AGENT_UNUSABLE` (`-32002`) is
  reported once and not retried. Use the latter only when the CLI this package
  ships cannot run at all.

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
- The SDK is pinned to an unpublished version while the `agent/list_models`
  `cwd` parameter lands. Until it is published, run every task through the
  git-ignored local override: `deno task -c deno.local.json <task>`. See README,
  "Building against an unpublished SDK".
- `deno task test` needs no CLI: discovery is exercised against a fake
  `HostProcesses` that scripts an ACP peer. `deno task simulate` needs a real
  `codeagent` on PATH.
- Bump `orax.toml` `version` before handing someone a `.orax` to import.
  `install_local` refuses a version that is already installed and never retires
  older ones, so reusing a number silently leaves the old code running.
