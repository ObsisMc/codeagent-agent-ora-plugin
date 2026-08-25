import type { JsonValue } from "@ora-space/plugin-sdk";
import { tryEachCandidate } from "./command.ts";
import { decodeLines, encodeLine } from "./ndjson.ts";

/** The subset of a spawned child process this bridge depends on, so tests can substitute one. */
export interface SpawnedProcess {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  readonly pid: number;
  kill(): void;
  readonly exited: Promise<void>;
}

export interface CodeAgentClientOptions {
  /** Overrides process spawning; injected by tests. */
  spawn?: (command: string, args: string[], cwd: string) => SpawnedProcess;
  /** Receives every ACP frame emitted by the CLI, in output order. */
  onAcpFrame?: (frame: JsonValue) => void;
  /** Invoked after the CLI exits on its own, never after an explicit stop. */
  onExited?: () => void;
}

interface RunningProcess {
  process: SpawnedProcess;
  stdinWriter: WritableStreamDefaultWriter<Uint8Array>;
}

/**
 * Owns one `codeagent acp` subprocess and bridges ACP frames between its stdio and Ora.
 *
 * The plugin owns the CLI's whole lifetime: spawn on `agent/start`, kill on `agent/stop`. Ora
 * never sees the child's stdio, which is what lets CodeAgent use ACP methods this host has never
 * heard of. Nothing here parses ACP; frames are re-framed between Ora's binary envelope and the
 * CLI's NDJSON and otherwise passed through verbatim.
 */
export class CodeAgentClient {
  readonly #spawn: (
    command: string,
    args: string[],
    cwd: string,
  ) => SpawnedProcess;
  readonly #onAcpFrame: (frame: JsonValue) => void;
  readonly #onExited: () => void;
  #running: RunningProcess | undefined;
  #expectedExit = false;

  constructor(options: CodeAgentClientOptions = {}) {
    this.#spawn = options.spawn ?? spawnCodeAgentProcess;
    this.#onAcpFrame = options.onAcpFrame ?? (() => {});
    this.#onExited = options.onExited ?? (() => {});
  }

  get running(): boolean {
    return this.#running !== undefined;
  }

  /**
   * Spawns `codeagent acp` in the given working directory and starts bridging its stdio.
   *
   * The directory is set as the child's own cwd rather than passed as a flag, so this works
   * whatever spelling the CLI gives its working-directory option — and an ACP agent reads its
   * per-session directories from `session/new` anyway.
   *
   * Any previous child is stopped first so a restart cannot leave two CLIs writing frames into
   * the same host connection.
   */
  async start(cwd: string): Promise<void> {
    await this.stop();
    this.#expectedExit = false;

    await tryEachCandidate((command) => {
      const process = this.#spawn(command, ["acp"], cwd);
      this.#running = { process, stdinWriter: process.stdin.getWriter() };
      this.#attach(process);
      return process;
    });
  }

  /**
   * Forwards one host ACP frame into the CLI's stdin as NDJSON.
   *
   * Awaiting the write is what lets the CLI's backpressure reach the host instead of growing an
   * unbounded queue inside this process.
   */
  async writeAcp(frame: JsonValue): Promise<void> {
    const running = this.#running;
    if (running === undefined) {
      throw new Error("the CodeAgent agent is not running");
    }
    await running.stdinWriter.write(encodeLine(JSON.stringify(frame)));
  }

  /**
   * Kills the CLI and releases every pipe; idempotent when already stopped.
   *
   * stdin is closed before the kill so a CLI that shuts down on EOF gets to exit on its own
   * terms. That matters most on Windows, where a `.cmd` shim would otherwise be killed while the
   * real CLI underneath it kept running.
   */
  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = undefined;
    this.#expectedExit = true;
    if (running === undefined) {
      return;
    }
    try {
      await running.stdinWriter.close();
    } catch {
      // The child already exited and closed its stdin; nothing is left to flush.
    }
    try {
      running.process.kill();
    } catch {
      // Already dead.
    }
  }

  /** Wires stdout, stderr, and exit bookkeeping for one live child. */
  #attach(process: SpawnedProcess): void {
    void this.#pumpStdout(process);
    void this.#pumpStderr(process);
    void process.exited.then(() => {
      if (this.#running?.process === process) {
        this.#running = undefined;
      }
      if (!this.#expectedExit) {
        console.warn("codeagent acp exited unexpectedly");
        this.#onExited();
      }
    });
  }

  /**
   * Forwards every NDJSON line the CLI prints as one ACP frame.
   *
   * A line that is not a JSON object is dropped with a warning rather than failing the bridge:
   * Ora rejects non-object frames anyway, and one stray diagnostic line must not end every live
   * session on this agent.
   */
  async #pumpStdout(process: SpawnedProcess): Promise<void> {
    try {
      for await (const line of decodeLines(process.stdout)) {
        let frame: JsonValue;
        try {
          frame = JSON.parse(line) as JsonValue;
        } catch {
          console.warn(`dropping non-JSON stdout line: ${line}`);
          continue;
        }
        if (
          frame === null || typeof frame !== "object" || Array.isArray(frame)
        ) {
          console.warn("dropping non-object ACP frame from codeagent");
          continue;
        }
        this.#onAcpFrame(frame);
      }
    } catch (error) {
      console.warn(`codeagent stdout read failed: ${error}`);
    }
  }

  /** Republishes the CLI's diagnostics on this plugin's stderr, which Ora logs. */
  async #pumpStderr(process: SpawnedProcess): Promise<void> {
    try {
      for await (const line of decodeLines(process.stderr)) {
        if (line.length > 0) {
          console.error(`[codeagent] ${line}`);
        }
      }
    } catch (error) {
      console.warn(`codeagent stderr read failed: ${error}`);
    }
  }
}

/** Spawns the CLI with all three stdio pipes exposed for streaming. */
function spawnCodeAgentProcess(
  command: string,
  args: string[],
  cwd: string,
): SpawnedProcess {
  const child = new Deno.Command(command, {
    args,
    cwd,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    pid: child.pid,
    kill: () => child.kill(),
    exited: child.status.then(() => undefined),
  };
}
