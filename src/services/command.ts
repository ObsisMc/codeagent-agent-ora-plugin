import {
  AGENT_NOT_INSTALLED,
  type AgentInvocation,
  type HostChildProcess,
  type HostProcesses,
  HostRequestError,
  PluginMethodError,
  spawnAgentProcess,
} from "@ora-space/plugin-sdk";

/** The CLI this plugin fronts; `codeagent acp` is its Agent Client Protocol mode. */
const BINARY_NAME = "codeagent";

/** Pins one exact executable, bypassing PATH resolution entirely. */
export const BIN_ENV_VAR = "ORA_CODEAGENT_BIN";

/**
 * Names the PATH spellings that can launch CodeAgent, in the order they should be tried.
 *
 * Windows gets four because installers disagree on what they put there — a `codeagent.bat`
 * wrapper, a native `codeagent.exe`, the `codeagent.cmd` shim npm and bun write, or an
 * extensionless launcher — and the host's PATH lookup appends `.exe` to a bare name rather than
 * trying the others, so a plugin naming only the bare command finds nothing on a machine that has
 * the CLI.
 *
 * `.bat` leads deliberately, against Windows' own `PATHEXT` precedence. CodeAgent is distributed
 * as a batch wrapper, so that is the spelling a real install answers to and putting it first means
 * discovery costs one host round trip instead of three misses before it. The tradeoff is real: on
 * a machine carrying both a wrapper and a native binary the host ends up holding `cmd.exe` rather
 * than the CLI, which is why `stop()` closes stdin before killing and why the host's kill is
 * tree-wide. A user who has a native binary and wants it held directly names it with
 * `ORA_CODEAGENT_BIN`.
 */
export function resolveCodeAgentCommands(): string[] {
  return Deno.build.os === "windows"
    ? [
      `${BINARY_NAME}.bat`,
      `${BINARY_NAME}.exe`,
      `${BINARY_NAME}.cmd`,
      BINARY_NAME,
    ]
    : [BINARY_NAME];
}

/**
 * Spawns the CodeAgent CLI through the host, whichever way this machine provides one.
 *
 * The host owns the OS process rather than this sandboxed runtime: it terminates process trees and
 * reclaims every child this plugin generation left behind, which a plugin spawning its own
 * `Deno.Command` cannot promise — least of all through a Windows `.cmd` shim, where the handle a
 * plugin holds is the shim and the real CLI underneath it can outlive a kill.
 *
 * No `packageCommand` is named because this package ships no CLI. That is a different statement
 * from a bundled path the host reports missing: naming one would claim an executable may exist
 * there, and one that turned out to exist and not run would fail the agent outright instead of
 * falling back to the user's own install.
 *
 * `ORA_CODEAGENT_BIN` outranks the PATH lookup, and is returned alone: a pin that quietly fell
 * back to whatever is on PATH would run a different CLI than the user asked for.
 */
export function spawnCodeAgent(
  processes: HostProcesses,
  invocation: AgentInvocation,
): Promise<HostChildProcess> {
  const pinned = readEnv(BIN_ENV_VAR)?.trim();
  if (pinned !== undefined && pinned !== "") {
    return spawnPinned(processes, pinned, invocation);
  }
  return spawnAgentProcess(processes, {
    command: resolveCodeAgentCommands(),
  }, invocation);
}

/**
 * Spawns the CLI a user named explicitly, reporting an absent one as local configuration.
 *
 * A pin pointing at nothing is the same kind of fault as an uninstalled CLI — fixable without
 * restarting Ora — so it stays retryable rather than failing this agent outright.
 */
async function spawnPinned(
  processes: HostProcesses,
  command: string,
  invocation: AgentInvocation,
): Promise<HostChildProcess> {
  try {
    return await processes.spawn({ command, ...invocation });
  } catch (error) {
    if (
      error instanceof HostRequestError && error.kind === "program_not_found"
    ) {
      throw new PluginMethodError(
        AGENT_NOT_INSTALLED,
        `${BIN_ENV_VAR} points at ${command}, which does not exist`,
      );
    }
    throw error;
  }
}

/** Reads an env var, treating a missing read permission as an unset value. */
function readEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    // The host may not grant --allow-env; absence is indistinguishable from "not set".
    return undefined;
  }
}
