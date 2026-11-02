/**
 * The T3 Code CLI (`t3 thread ...`) as four calls. The CLI acts on the
 * running T3 Code server on this host and needs no token.
 */

export type T3ThreadSummary = { threadId: string; title: string; status: string };
/** Provider instance id and model slug, for projects with no default model. */
export type T3ModelSelection = { provider: string; model: string };

type RunResult = { code: number; stdout: string; stderr: string };

export class T3 {
  constructor(
    private readonly bin: string = "t3",
    private readonly modelSelection?: T3ModelSelection,
  ) {}

  private async run(args: string[], stdin?: string): Promise<RunResult> {
    const proc = Bun.spawn([this.bin, ...args], {
      stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  private fail(what: string, result: RunResult): never {
    throw new Error(`${what} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 400)}`);
  }

  /** Whether a thread still exists. Throws when the server cannot answer. */
  async show(threadId: string): Promise<"alive" | "gone"> {
    const result = await this.run(["thread", "show", threadId, "--json", "--messages", "0"]);
    if (result.code === 0) return "alive";
    if (/no longer available|not found/i.test(result.stderr + result.stdout)) return "gone";
    return this.fail(`t3 thread show ${threadId}`, result);
  }

  /** A project's threads, newest first. */
  async list(project: string): Promise<T3ThreadSummary[]> {
    const result = await this.run(["thread", "list", "--project", project, "--json"]);
    if (result.code !== 0) this.fail("t3 thread list", result);
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) throw new Error("t3 thread list printed no array");
    return parsed as T3ThreadSummary[];
  }

  /** Starts a thread with `message` as its first turn and returns the thread id. */
  async start(project: string, title: string, message: string): Promise<string> {
    const model = this.modelSelection ? ["--provider", this.modelSelection.provider, "--model", this.modelSelection.model] : [];
    const result = await this.run(["thread", "start", project, "-", "--title", title, ...model, "--json"], message);
    if (result.code !== 0) this.fail("t3 thread start", result);
    const threadId = threadIdFrom(result.stdout);
    if (!threadId) throw new Error(`t3 thread start printed no thread id: ${result.stdout.trim().slice(0, 200)}`);
    return threadId;
  }

  /** Queues `message` as the thread's next turn. */
  async send(threadId: string, message: string): Promise<void> {
    const result = await this.run(["thread", "send", threadId, "-", "--json"], message);
    if (result.code !== 0) this.fail(`t3 thread send ${threadId}`, result);
  }
}

/** The thread id from `t3 thread start --json` output, with the plain-text form as a fallback. */
function threadIdFrom(stdout: string): string | null {
  const text = stdout.trim();
  try {
    const parsed = JSON.parse(text) as { threadId?: unknown; thread?: { threadId?: unknown } };
    const id = parsed.threadId ?? parsed.thread?.threadId;
    if (typeof id === "string" && id.length > 0) return id;
  } catch {
    // Plain text: the id on its own line.
  }
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return line && !line.includes(" ") ? line : null;
}
