import type { AgentModel } from "@ora-space/plugin-sdk";
import { tryEachCandidate } from "../services/command.ts";

/** Reads the raw model id list from CodeAgent; injectable so the cache can be exercised. */
export type ModelIdSource = () => Promise<string[]>;

/**
 * Offered when CodeAgent cannot be asked for its real list.
 *
 * An empty picker is indistinguishable from a broken agent in the UI, so one entry keeps the
 * agent selectable. It names no provider on purpose: guessing concrete model ids for a CLI that
 * did not answer would put ids in the picker that the CLI may well reject.
 */
const FALLBACK_MODELS: AgentModel[] = [
  { id: "default", displayName: "CodeAgent default", default: true },
];

let cache: Promise<AgentModel[]> | undefined;

/**
 * Serves `agent/listModels`, cached for the plugin process lifetime.
 *
 * Ora asks for models before any session exists and may ask repeatedly while the pickers render,
 * and `codeagent models` spawns a whole CLI, so the first answer is reused. A model list that
 * changes because the user logged into a new provider therefore needs a plugin restart.
 */
export function listCodeAgentModels(
  source: ModelIdSource = runCodeAgentModels,
): Promise<AgentModel[]> {
  if (cache === undefined) {
    cache = discoverModels(source);
  }
  return cache;
}

/** Reads the live list, falling back to the single default when CodeAgent cannot answer. */
async function discoverModels(source: ModelIdSource): Promise<AgentModel[]> {
  try {
    const ids = await source();
    if (ids.length > 0) {
      // No model is marked default from the live list: the CLI's own default lives in its config
      // and is not exposed by `codeagent models`, so guessing one here would silently override
      // the user's choice.
      return ids.map((id) => ({ id, displayName: displayNameFor(id) }));
    }
  } catch (error) {
    console.warn(`model discovery failed, using defaults: ${error}`);
  }
  return FALLBACK_MODELS;
}

/** Strips the `provider/` prefix so the picker shows a short name. */
function displayNameFor(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}

/** Runs `codeagent models` and returns the non-empty id lines it prints. */
async function runCodeAgentModels(): Promise<string[]> {
  const output = await tryEachCandidate(async (command) => {
    const { code, stdout } = await new Deno.Command(command, {
      args: ["models"],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (code !== 0) {
      throw new Error(`codeagent models exited with code ${code}`);
    }
    return new TextDecoder().decode(stdout);
  });

  const ids = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (ids.length === 0) {
    throw new Error("codeagent models returned no model ids");
  }
  return ids;
}
