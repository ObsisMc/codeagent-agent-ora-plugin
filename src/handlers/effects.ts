import type {
  AgentEffectCoordinationContext,
  AgentEffectDefinition,
  AgentEffectReadinessContext,
  EffectResourceDeclaration,
  JsonValue,
} from "@ora-space/plugin-sdk";
import { PluginMethodError, SKILL_DIRECTORY_V1 } from "@ora-space/plugin-sdk";
import type { CodeAgentClient } from "../services/codeagent-client.ts";
import { invalidateCodeAgentModels } from "./models.ts";

/**
 * The Skill Resource CodeAgent reads: a project-relative `.codeagent/skills/<name>/SKILL.md` tree.
 *
 * The path is the one thing here that is a property of the CLI rather than of this plugin, and it
 * is deliberately the agent's own directory rather than a compatibility one. CodeAgent may also
 * read `.claude/skills` or `.agents/skills` the way sibling CLIs do, but those are Preserved State
 * from this plugin's point of view: Ora fully owns what it materializes into a declared Resource,
 * so declaring a shared directory would have Ora reconcile away Skills another tool put there.
 *
 * If the CLI turns out to read a different directory, this constant is the only edit needed —
 * everything below coordinates a restart and never looks at the path.
 */
export const SKILLS_RESOURCE: EffectResourceDeclaration = {
  workspaceRelativePath: ".codeagent/skills",
  materializationFormat: SKILL_DIRECTORY_V1,
  coordination: "quiesce_before_mutation",
};

const SESSION_PROMPT_METHOD = "session/prompt";

/** The code this plugin reports a Consumer call it cannot satisfy right now under. */
const CONSUMER_NOT_READY = -32000;

/**
 * How long `effect/coordinate` waits for in-flight turns before reporting the Target still busy.
 *
 * Ora allows a plugin control call 30 seconds and coordination holds that call open, so this has
 * to finish well inside it. Waiting at all is worth it because the common case is a turn seconds
 * from finishing; past that the honest answer is to fail this attempt and let Ora's reconcile
 * schedule bring the mutation back, rather than hold a host call for the length of a prompt that
 * may legitimately run for minutes.
 */
const QUIESCE_TIMEOUT_MS = 10_000;

/** How often the drain loop rechecks whether every in-flight turn has answered. */
const QUIESCE_POLL_MS = 50;

/**
 * Coordinates the `.codeagent/skills` Effect Resource against the one CLI process this plugin owns.
 *
 * A Skill edit on disk reaches the CLI only once the CLI reads the directory again, and when that
 * happens is the CLI's business — at startup for an agent that scans once, at `session/new` for
 * one that resolves per session. Respawning covers both, so this coordinates a restart rather than
 * trying to model which of the two CodeAgent does: the process serving the next turn is always one
 * that started after the write.
 *
 * In-flight `session/prompt` turns are tracked from the ACP frames already flowing through the
 * bridge — nothing here parses ACP beyond `method` and `id` — and Ora's three Consumer calls are
 * answered around that: `coordinate` holds new turns behind a barrier and waits for the running
 * ones, `reactivate` respawns the CLI and replays what was held, and `verifyReady` reports whether
 * the process Ora is about to mark ready is one that has actually read the Skills on disk.
 */
export class SkillEffectCoordinator {
  readonly #client: CodeAgentClient;
  readonly #cwd: () => string | undefined;
  readonly #openTurns = new Set<string | number>();
  /** `undefined` while no barrier is held; an array from the moment `coordinate` engages one. */
  #held: JsonValue[] | undefined;

  constructor(client: CodeAgentClient, cwd: () => string | undefined) {
    this.#client = client;
    this.#cwd = cwd;
  }

  readonly definition: AgentEffectDefinition = {
    resources: [SKILLS_RESOURCE],
    coordinate: (context) => this.#coordinate(context),
    reactivate: (context) => this.#reactivate(context),
    verifyReady: (context) => this.#verifyReady(context),
  };

  /**
   * Observes one host-to-agent frame before it would be forwarded, absorbing it instead if the
   * barrier is holding new turns. Returns whether the frame was absorbed.
   */
  intercept(frame: JsonValue): boolean {
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      return false;
    }
    const { method, id } = frame;
    if (
      typeof method !== "string" ||
      (typeof id !== "string" && typeof id !== "number")
    ) {
      return false;
    }
    if (method !== SESSION_PROMPT_METHOD) {
      return false;
    }
    if (this.#held !== undefined) {
      this.#held.push(frame);
      return true;
    }
    this.#openTurns.add(id);
    return false;
  }

  /** Observes one agent-to-host frame, clearing turn tracking once a prompt resolves. */
  observe(frame: JsonValue): void {
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      return;
    }
    if ("method" in frame) {
      return; // requests and notifications the CLI sends are not responses.
    }
    const { id } = frame;
    if (typeof id !== "string" && typeof id !== "number") {
      return;
    }
    this.#openTurns.delete(id);
  }

  /**
   * Engages the new-turn barrier, then reports safe to mutate once every running turn has
   * answered.
   *
   * The barrier goes up before the wait, not after it. A check that only latched on an observed
   * idle moment would never find one in a workspace whose prompts keep arriving; holding first
   * makes the set of turns to wait for finite, so the wait always terminates.
   *
   * Idempotent, as Ora requires of both coordination calls: a repeat finds the barrier already up
   * and the turn set already drained, and returns without touching anything.
   */
  async #coordinate(
    context: AgentEffectCoordinationContext,
  ): Promise<JsonValue> {
    this.#held ??= [];
    const deadline = Date.now() + QUIESCE_TIMEOUT_MS;
    while (this.#openTurns.size > 0) {
      if (Date.now() >= deadline) {
        // Ora only reactivates Targets whose coordination succeeded, so a barrier abandoned here
        // would hold its queued prompts for the life of the process. Release before failing, and
        // let the next reconcile attempt engage a fresh one.
        const stranded = this.#openTurns.size;
        await this.#release();
        throw new PluginMethodError(
          CONSUMER_NOT_READY,
          `CodeAgent still has ${stranded} turn(s) in flight`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, QUIESCE_POLL_MS));
    }
    return { targetId: context.targetId, state: "safe_to_mutate" };
  }

  /**
   * Restarts the CLI so it reads `.codeagent/skills` again, then replays every held turn in order.
   *
   * The barrier is the idempotence marker: a repeat call finds none held — exactly the state a
   * finished reactivation leaves behind — and does not restart a CLI that has already rescanned,
   * which would tear down the sessions that came back after the first restart.
   */
  async #reactivate(
    context: AgentEffectCoordinationContext,
  ): Promise<JsonValue> {
    if (this.#held === undefined) {
      return { targetId: context.targetId, state: "reactivated" };
    }
    const cwd = this.#cwd();
    if (cwd !== undefined) {
      invalidateCodeAgentModels(cwd);
      await this.#client.start(cwd);
    }
    await this.#release();
    return { targetId: context.targetId, state: "reactivated" };
  }

  /**
   * Reports whether the running CLI can consume this exact Target projection.
   *
   * The proof this plugin can offer is that a process is up and no mutation is mid-flight: every
   * Skill write is followed by a restart, so a CLI running outside a coordination episode is one
   * that started after the last write and has read what is on disk. Anything else throws, which is
   * how a Consumer says "not ready" — Ora records readiness only from a call that returned.
   */
  #verifyReady(context: AgentEffectReadinessContext): JsonValue {
    if (!this.#client.running) {
      throw new PluginMethodError(
        CONSUMER_NOT_READY,
        "the CodeAgent CLI is not running, so it has read no Skills",
      );
    }
    if (this.#held !== undefined) {
      throw new PluginMethodError(
        CONSUMER_NOT_READY,
        "CodeAgent is quiesced for a Skill mutation and has not rescanned yet",
      );
    }
    return {
      targetId: context.targetId,
      generation: context.generation,
      consumerRevisionId: context.consumerRevisionId,
      projectionDigest: context.projectionDigest,
    };
  }

  /**
   * Drains every held turn into the CLI, then lets new ones through again.
   *
   * The queue length is rechecked on every iteration rather than snapshotted, so a
   * `session/prompt` that `intercept` absorbs while the drain is still running is replayed in this
   * pass instead of being stranded behind a barrier that is about to come down.
   */
  async #release(): Promise<void> {
    while (this.#held !== undefined && this.#held.length > 0) {
      const frame = this.#held.shift();
      if (frame !== undefined) {
        await this.#client.writeAcp(frame);
      }
    }
    this.#held = undefined;
  }
}
