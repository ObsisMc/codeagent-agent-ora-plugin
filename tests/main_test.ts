import { assertEquals, assertRejects } from "@std/assert";
import type {
  HostChildProcess,
  HostChildProcessOptions,
  HostProcesses,
  JsonValue,
} from "@ora-space/plugin-sdk";
import { AGENT_NOT_INSTALLED, HostRequestError } from "@ora-space/plugin-sdk";
import { listCodeAgentModels } from "../src/handlers/models.ts";
import {
  BIN_ENV_VAR,
  resolveCodeAgentCommands,
} from "../src/services/command.ts";
import { decodeLines } from "../src/services/ndjson.ts";

Deno.test("ora-space.codeagent declares an agent kind", async () => {
  const manifest = await Deno.readTextFile(
    new URL("../orax.toml", import.meta.url),
  );
  assertEquals(manifest.includes('kind = "agent"'), true);
});

Deno.test("Windows tries the native binary before the shim", () => {
  assertEquals(
    resolveCodeAgentCommands(),
    Deno.build.os === "windows"
      ? ["codeagent.exe", "codeagent.cmd", "codeagent.bat", "codeagent"]
      : ["codeagent"],
  );
});

Deno.test("a pinned binary is the only program spawned", async () => {
  const spawns: HostChildProcessOptions[] = [];
  await withPinnedBinary("C:\\tools\\codeagent.exe", async () => {
    await listCodeAgentModels(
      fakeProcesses(defaultAcpAgent, spawns),
      uniqueWorkspace(),
    );
  });
  assertEquals(spawns.map((options) => options.command), [
    "C:\\tools\\codeagent.exe",
  ]);
  // A pin names one exact executable, so nothing about the package is asked of the host either.
  assertEquals(
    spawns.every((options) => options.packageCommand === undefined),
    true,
  );
});

Deno.test("a pin that names nothing is reported as a missing CLI", async () => {
  const missing: HostProcesses = {
    spawn: () =>
      Promise.reject(
        new HostRequestError("program_not_found", "no such program"),
      ),
  };
  await withPinnedBinary("C:\\tools\\absent.exe", async () => {
    const error = await assertRejects(() =>
      listCodeAgentModels(missing, uniqueWorkspace())
    );
    // Ora retries this code quietly as expected local configuration rather than faulting the
    // agent, which is the whole difference between "not installed" and "broken".
    assertEquals((error as { code?: number }).code, AGENT_NOT_INSTALLED);
  });
});

Deno.test("models come from the probe session's model config option", async () => {
  const models = await listCodeAgentModels(
    fakeProcesses(defaultAcpAgent),
    uniqueWorkspace(),
  );
  assertEquals(models, [
    { id: "fast", displayName: "Fast", default: false },
    { id: "deep", displayName: "Deep", default: true },
    { id: "grouped", displayName: "Grouped", default: false },
  ]);
});

Deno.test("the probe declares the capability that reveals a model selector", async () => {
  const requests: Record<string, JsonValue>[] = [];
  await listCodeAgentModels(
    fakeProcesses((request) => {
      requests.push(request);
      return defaultAcpAgent(request);
    }),
    uniqueWorkspace(),
  );
  const initialize = requests.find((request) =>
    request.method === "initialize"
  );
  assertEquals(
    (initialize?.params as { clientCapabilities?: JsonValue })
      ?.clientCapabilities,
    { session: { configOptions: {} } },
  );
  // An agent that serves no session/delete must not be sent one: it would fail on every probe.
  assertEquals(
    requests.some((request) => request.method === "session/delete"),
    false,
  );
});

Deno.test("an agent offering no selector discovers no pre-session models", async () => {
  const models = await listCodeAgentModels(
    fakeProcesses((request) =>
      request.method === "session/new"
        ? { sessionId: "s1", configOptions: [] }
        : defaultAcpAgent(request)
    ),
    uniqueWorkspace(),
  );
  assertEquals(models, []);
});

Deno.test("one workspace is probed once while its answer is fresh", async () => {
  const spawns: HostChildProcessOptions[] = [];
  const processes = fakeProcesses(defaultAcpAgent, spawns);
  const cwd = uniqueWorkspace();
  const [first, second] = await Promise.all([
    listCodeAgentModels(processes, cwd),
    listCodeAgentModels(processes, cwd),
  ]);
  assertEquals(first, second);
  assertEquals(spawns.length, 1);
});

Deno.test("discovery without a workspace is refused rather than guessed", () => {
  const error = (() => {
    try {
      listCodeAgentModels(fakeProcesses(defaultAcpAgent), "");
      return undefined;
    } catch (thrown) {
      return thrown as { code?: number };
    }
  })();
  assertEquals(error?.code, -32602);
});

Deno.test("NDJSON reassembles frames split across chunks and CRLF", async () => {
  const chunks = ['{"a":1}\r\n{"b":', '2}\n\n{"c":3}'];
  const stream = ReadableStream.from(
    chunks.map((chunk) => new TextEncoder().encode(chunk)),
  );

  const lines: string[] = [];
  for await (const line of decodeLines(stream)) lines.push(line);

  assertEquals(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

/**
 * Returns a workspace path no other test has used.
 *
 * Discovery caches its answer per workspace for the process lifetime, so tests that shared a
 * directory would silently read each other's result instead of running their own probe.
 */
let workspaceCounter = 0;
function uniqueWorkspace(): string {
  workspaceCounter += 1;
  return `/workspace/${workspaceCounter}`;
}

/** Runs `body` with the CLI pin set, restoring whatever the environment had before. */
async function withPinnedBinary(
  value: string,
  body: () => Promise<void>,
): Promise<void> {
  const previous = Deno.env.get(BIN_ENV_VAR);
  Deno.env.set(BIN_ENV_VAR, value);
  try {
    await body();
  } finally {
    if (previous === undefined) Deno.env.delete(BIN_ENV_VAR);
    else Deno.env.set(BIN_ENV_VAR, previous);
  }
}

/** Answers one ACP request the way a CodeAgent CLI with a model selector would. */
function defaultAcpAgent(request: Record<string, JsonValue>): JsonValue {
  if (request.method === "initialize") {
    // No `sessionCapabilities.delete`, like an agent that cannot remove a session.
    return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
  }
  if (request.method === "session/new") {
    return {
      sessionId: "probe-session",
      configOptions: [
        {
          id: "mode",
          name: "Mode",
          type: "select",
          currentValue: "edit",
          options: [],
        },
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "deep",
          options: [
            { value: "fast", name: "Fast" },
            { value: "deep", name: "Deep" },
            {
              group: "extra",
              name: "Extra",
              options: [{ value: "grouped", name: "Grouped" }],
            },
          ],
        },
      ],
    };
  }
  throw new Error(`unexpected ACP method ${String(request.method)}`);
}

/**
 * Builds a `HostProcesses` whose children speak ACP from `respond`, recording every spawn.
 *
 * The plugin no longer spawns anything itself — the host does, on its behalf — so the seam a test
 * substitutes at is the host's process client rather than `Deno.Command`. That also lets one
 * scripted CLI stand in for a machine that has none installed.
 */
function fakeProcesses(
  respond: (request: Record<string, JsonValue>) => JsonValue,
  spawns: HostChildProcessOptions[] = [],
): HostProcesses {
  return {
    spawn(options) {
      spawns.push(options);
      let stdout: ReadableStreamDefaultController<Uint8Array> | undefined;
      let ended: (() => void) | undefined;
      const child: HostChildProcess = {
        pid: 1234,
        stdout: new ReadableStream({
          start: (controller) => {
            stdout = controller;
          },
        }),
        stderr: new ReadableStream({
          start: (controller) => controller.close(),
        }),
        exited: new Promise((resolve) => {
          ended = () => resolve({ code: 0, signal: null });
        }),
        write: (bytes) => {
          for (const line of new TextDecoder().decode(bytes).split("\n")) {
            if (line.trim() === "") continue;
            const request = JSON.parse(line) as Record<string, JsonValue>;
            const answer = JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: respond(request),
            });
            stdout?.enqueue(new TextEncoder().encode(`${answer}\n`));
          }
          return Promise.resolve();
        },
        closeStdin: () => Promise.resolve(),
        kill: () => {
          stdout?.close();
          ended?.();
          return Promise.resolve();
        },
      };
      return Promise.resolve(child);
    },
  };
}
