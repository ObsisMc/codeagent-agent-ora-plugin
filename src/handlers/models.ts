import type { AgentModel } from "@ora-space/plugin-sdk";
/**
 * Serves `agent/list_models` with an empty pre-session model list.
 *
 * CodeAgent publishes its live model choices through the `configOptions` returned by ACP
 * `session/new`. Those session-scoped options are already forwarded to Ora unchanged. Calling
 * the separate `codeagent models` command here would create a second model source that can
 * disagree with the active ACP session.
 *
 * The host calls this method before a session is available, so the ACP options cannot be copied
 * into this response reliably. An empty list tells Ora to use the model configuration advertised
 * by the session instead.
 */
export function listCodeAgentModels(): AgentModel[] {
  return [];
}
