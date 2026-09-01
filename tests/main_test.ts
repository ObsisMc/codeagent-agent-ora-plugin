import { assertEquals } from "@std/assert";
import { listCodeAgentModels } from "../src/handlers/models.ts";
import {
  BIN_ENV_VAR,
  isCommandNotFound,
  resolveCodeAgentCommands,
} from "../src/services/command.ts";
import { decodeLines } from "../src/services/ndjson.ts";

Deno.test("ora-space.codeagent declares an agent kind", async () => {
  const manifest = await Deno.readTextFile(
    new URL("../orax.toml", import.meta.url),
  );
  assertEquals(manifest.includes('kind = "agent"'), true);
});

Deno.test("models are supplied by ACP rather than the pre-session API", () => {
  assertEquals(listCodeAgentModels(), []);
});

Deno.test("a pinned binary is the only candidate", () => {
  const previous = Deno.env.get(BIN_ENV_VAR);
  Deno.env.set(BIN_ENV_VAR, "C:\\tools\\codeagent.exe");
  try {
    assertEquals(resolveCodeAgentCommands(), ["C:\\tools\\codeagent.exe"]);
  } finally {
    if (previous === undefined) Deno.env.delete(BIN_ENV_VAR);
    else Deno.env.set(BIN_ENV_VAR, previous);
  }
});

Deno.test("Windows tries the native binary before the shim", () => {
  const previous = Deno.env.get(BIN_ENV_VAR);
  Deno.env.delete(BIN_ENV_VAR);
  try {
    const candidates = resolveCodeAgentCommands();
    assertEquals(
      candidates,
      Deno.build.os === "windows"
        ? ["codeagent.exe", "codeagent.cmd", "codeagent"]
        : ["codeagent"],
    );
  } finally {
    if (previous !== undefined) Deno.env.set(BIN_ENV_VAR, previous);
  }
});

Deno.test("a Windows shell miss is classified as a missing binary", () => {
  assertEquals(
    isCommandNotFound(
      new Error(
        "'codeagent' is not recognized as an internal or external command",
      ),
    ),
    true,
  );
  assertEquals(isCommandNotFound(new Error("permission denied")), false);
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
