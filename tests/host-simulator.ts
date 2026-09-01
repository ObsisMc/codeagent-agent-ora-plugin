/**
 * Drives the plugin exactly the way Ora's host does, against a real CodeAgent CLI.
 *
 * Run it with the same permissions Ora grants an agent plugin:
 *   deno task simulate
 */
import type { JsonValue } from "@ora-space/plugin-sdk";

const JSON_RPC_FRAME_TYPE = 0x01;
const MAX_FRAME_LENGTH = 16 * 1024 * 1024;

/**
 * Encodes and decodes Ora's binary JSON-RPC frame envelope.
 *
 * This is a standalone reimplementation of the wire format, not an import from the plugin SDK:
 * this file plays the host's side of the protocol, and the host does not depend on the SDK it is
 * exercising.
 */

/** Encodes one JSON value into Ora's binary JSON-RPC frame envelope. */
function encodeFrame(message: JsonValue): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const length = payload.byteLength + 1;
  if (length > MAX_FRAME_LENGTH) {
    throw new Error(`Plugin frame exceeds ${MAX_FRAME_LENGTH} bytes`);
  }

  const frame = new Uint8Array(length + 4);
  new DataView(frame.buffer).setUint32(0, length, false);
  frame[4] = JSON_RPC_FRAME_TYPE;
  frame.set(payload, 5);
  return frame;
}

/** Decodes arbitrarily fragmented bytes into complete JSON-RPC messages. */
async function* decodeFrames(
  readable: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  let buffer = new Uint8Array();
  for await (const chunk of readable) {
    const combined = new Uint8Array(buffer.byteLength + chunk.byteLength);
    combined.set(buffer);
    combined.set(chunk, buffer.byteLength);
    buffer = combined;

    while (buffer.byteLength >= 4) {
      const length = new DataView(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength,
      ).getUint32(0, false);
      if (length < 1 || length > MAX_FRAME_LENGTH) {
        throw new Error(`Invalid plugin frame length ${length}`);
      }
      if (buffer.byteLength < length + 4) {
        break;
      }
      if (buffer[4] !== JSON_RPC_FRAME_TYPE) {
        throw new Error(`Unsupported plugin frame type ${buffer[4]}`);
      }

      const payload = buffer.slice(5, length + 4);
      buffer = buffer.slice(length + 4);
      yield JSON.parse(new TextDecoder().decode(payload));
    }
  }

  if (buffer.byteLength !== 0) {
    throw new Error("Plugin protocol stream ended inside a frame");
  }
}

const HOST_PERMISSIONS = [
  "--no-prompt",
  "--allow-run",
  "--allow-read",
  "--allow-env",
  "--allow-net",
];

/** Converts this module-relative URL into a host path, including a Windows drive prefix. */
const entrypoint = decodeURIComponent(
  new URL("../src/main.ts", import.meta.url).pathname,
).replace(/^\/([A-Za-z]:)/, "$1");
const child = new Deno.Command(Deno.execPath(), {
  args: ["run", ...HOST_PERMISSIONS, entrypoint],
  stdin: "piped",
  stdout: "piped",
  stderr: "inherit",
}).spawn();

const writer = child.stdin.getWriter();
const send = (message: JsonValue) => writer.write(encodeFrame(message));
const inbound = decodeFrames(child.stdout)[Symbol.asyncIterator]();

/** Reads frames until one satisfies `match`, so streamed notifications never desynchronize. */
async function waitFor(
  match: (message: Record<string, unknown>) => boolean,
  label: string,
): Promise<Record<string, unknown>> {
  while (true) {
    const next = await inbound.next();
    if (next.done) {
      throw new Error(`plugin closed stdout while waiting for ${label}`);
    }
    const message = next.value as Record<string, unknown>;
    if (match(message)) {
      return message;
    }
    console.log(`[host] << ${JSON.stringify(message).slice(0, 160)}`);
  }
}

/** Fails the simulation loudly and narrows values for the checks that follow. */
function check(condition: unknown, label: string): asserts condition {
  if (!condition) {
    throw new Error(`check failed: ${label}`);
  }
}

const acpFrame = (message: Record<string, unknown>): Record<string, unknown> =>
  (message.params ?? {}) as Record<string, unknown>;

const register = await waitFor(
  (message) => message.method === "ora/register",
  "ora/register",
);
console.log(`ok: register ${JSON.stringify(register.params)}`);

await send({
  jsonrpc: "2.0",
  id: 1,
  method: "agent/start",
  params: { cwd: Deno.cwd(), hostVersion: "0.8.0" },
});
const started = await waitFor((message) => message.id === 1, "agent/start");
console.log(
  `ok: agent/start ${JSON.stringify(started.result ?? started.error)}`,
);

await send({
  jsonrpc: "2.0",
  method: "agent/acp",
  params: {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    },
  },
});
const initialized = await waitFor(
  (message) => message.method === "agent/acp" && acpFrame(message).id === 1,
  "ACP initialize",
);
console.log(
  `ok: initialize ${
    JSON.stringify(acpFrame(initialized).result).slice(0, 200)
  }`,
);

await send({
  jsonrpc: "2.0",
  method: "agent/acp",
  params: {
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd: Deno.cwd(), mcpServers: [] },
  },
});
const session = await waitFor(
  (message) => message.method === "agent/acp" && acpFrame(message).id === 2,
  "ACP session/new",
);
const sessionResult = acpFrame(session).result as {
  sessionId?: string;
  configOptions?: { id: string; category?: string; options?: unknown[] }[];
} | undefined;
check(
  typeof sessionResult?.sessionId === "string",
  "session/new returns an id",
);
const modelOption = sessionResult?.configOptions?.find(
  (option) => option.category === "model",
);
check(modelOption !== undefined, "session/new carries a model config option");
check(
  Array.isArray(modelOption.options) && modelOption.options.length > 0,
  "the ACP model config option contains choices",
);
console.log(
  `ok: session/new ${sessionResult.sessionId} models via ACP: ${
    JSON.stringify(
      modelOption.options?.map((option) =>
        (option as { value?: unknown }).value
      ),
    )
  }`,
);

await send({ jsonrpc: "2.0", id: 2, method: "agent/list_models", params: {} });
const models = await waitFor(
  (message) => message.id === 2,
  "agent/list_models",
);
const modelList = ((models.result ?? {}) as { models?: unknown[] }).models;
check(
  Array.isArray(modelList) && modelList.length === 0,
  "agent/list_models is empty because CodeAgent publishes models through ACP",
);
console.log("ok: list_models [] (CodeAgent publishes models through ACP only)");

await send({ jsonrpc: "2.0", id: 3, method: "agent/stop", params: {} });
await waitFor((message) => message.id === 3, "agent/stop");
console.log("ok: agent/stop");

await send({ jsonrpc: "2.0", method: "ora/shutdown" });
await writer.close();
const status = await child.status;
console.log(`plugin exited with code ${status.code}`);
console.log(
  status.success
    ? "ALL HOST SIMULATION CHECKS PASSED"
    : "PLUGIN EXITED NON-ZERO",
);
Deno.exit(status.success ? 0 : 1);
