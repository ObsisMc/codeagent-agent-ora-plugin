import type {
  AcpSender,
  AgentModel,
  AgentStartContext,
  JsonValue,
} from "@ora-space/plugin-sdk";
import {
  AgentPlugin,
  type PluginContext,
  runAgentPlugin,
} from "./base/agent-plugin.ts";
import { forwardAcpFrame } from "./handlers/acp.ts";
import { startCodeAgent, stopCodeAgent } from "./handlers/lifecycle.ts";
import { listCodeAgentModels } from "./handlers/models.ts";
import { CodeAgentClient } from "./services/codeagent-client.ts";

/** Must match `name` in orax.toml, which is also this agent's identity inside Ora. */
const PLUGIN_ID = "ora-space.codeagent";

/**
 * Publishes CodeAgent as an Ora agent.
 *
 * One plugin process is one agent, so this class owns exactly one CLI and needs no addressing of
 * its own. Every API is delegated to a handler module, which keeps the entrypoint to wiring: the
 * sender handed in by `agent/start`, the CLI bridge, and the route mounting below.
 */
class CodeAgentPlugin extends AgentPlugin {
  /** Valid only between `agent/start` and the end of the process; frames before that are lost. */
  #send: AcpSender | undefined;

  readonly #client = new CodeAgentClient({
    onAcpFrame: (frame) => {
      // A send failure means the host connection is already gone; there is nothing this plugin
      // can do with the frame, and throwing here would only kill the stdout pump.
      void this.#send?.(frame).catch((error) => {
        console.warn(`failed to forward ACP frame to the host: ${error}`);
      });
    },
    onExited: () => {
      console.warn(
        "the CodeAgent CLI exited on its own; Ora decides whether to reconnect",
      );
    },
  });

  override onActivate(context: PluginContext): void {
    console.info(`${context.pluginId} activated`);
  }

  override onStart = async (
    context: AgentStartContext,
    send: AcpSender,
  ): Promise<void> => {
    this.#send = send;
    await startCodeAgent(this.#client, context);
  };

  override onStop = (): Promise<void> => stopCodeAgent(this.#client);

  override onListModels = (): Promise<AgentModel[]> => listCodeAgentModels();

  override onAcp = (frame: JsonValue): Promise<void> | void =>
    forwardAcpFrame(this.#client, frame);

  override async onDeactivate(): Promise<void> {
    await this.#client.stop();
  }
}

await runAgentPlugin(new CodeAgentPlugin(), { pluginId: PLUGIN_ID });
