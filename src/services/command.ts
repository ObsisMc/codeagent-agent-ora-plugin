import { AGENT_NOT_INSTALLED, PluginMethodError } from "@ora-space/plugin-sdk";

/** The CLI this plugin fronts; `codeagent acp` is its Agent Client Protocol mode. */
const BINARY_NAME = "codeagent";

/** Pins one exact executable, bypassing PATH resolution entirely. */
export const BIN_ENV_VAR = "ORA_CODEAGENT_BIN";

/**
 * Resolves the commands that can launch CodeAgent, in the order they should be tried.
 *
 * A pin is returned alone: a pin that quietly fell back to whatever is on PATH would run a
 * different CLI than the user asked for, which is worse than failing.
 *
 * Windows gets three spellings because installers disagree on what they put on PATH — a native
 * `codeagent.exe`, an npm/bun-style `codeagent.cmd` shim, or an extensionless launcher. The
 * `.exe` is tried first: a batch shim runs under `cmd.exe`, so the process this plugin holds is
 * the shim rather than the CLI, and killing it on `agent/stop` can leave the real child behind.
 */
export function resolveCodeAgentCommands(): string[] {
  const explicit = readEnv(BIN_ENV_VAR)?.trim();
  if (explicit !== undefined && explicit !== "") {
    return [explicit];
  }
  return Deno.build.os === "windows"
    ? [`${BINARY_NAME}.exe`, `${BINARY_NAME}.cmd`, BINARY_NAME]
    : [BINARY_NAME];
}

/** Classifies a spawn failure as a missing binary, tolerating platform error wording. */
export function isCommandNotFound(error: unknown): boolean {
  if (error instanceof Deno.errors.NotFound) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /not found|cannot find|no such file|is not recognized/i.test(message);
}

/**
 * Runs `attempt` against every candidate command until one does not throw.
 *
 * Failures are classified on the way out: a failure that is not "binary missing" is the real
 * startup fault and is rethrown as-is, while an exhausted candidate list means CodeAgent is
 * simply absent. That distinction is the whole point — Ora retries `AGENT_NOT_INSTALLED` quietly
 * as expected local configuration, and reports anything else as a fault.
 */
export async function tryEachCandidate<T>(
  attempt: (command: string) => T | Promise<T>,
): Promise<T> {
  const candidates = resolveCodeAgentCommands();
  const failures: unknown[] = [];
  for (const command of candidates) {
    try {
      return await attempt(command);
    } catch (error) {
      failures.push(error);
    }
  }

  const realFailure = failures.find((error) => !isCommandNotFound(error));
  if (realFailure !== undefined) {
    throw realFailure instanceof Error
      ? realFailure
      : new Error(String(realFailure));
  }
  throw new PluginMethodError(
    AGENT_NOT_INSTALLED,
    `CodeAgent is not installed or not on PATH (tried: ${
      candidates.join(", ")
    }); install the CodeAgent CLI or set ${BIN_ENV_VAR} to its full path`,
  );
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
