import { spawn } from "node:child_process";

export type CommandOutputEncoding = "buffer" | "utf8";

export interface CommandResult<Stdout extends Buffer | string = string> {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: Stdout;
}

export interface RunCommandOptions {
  args?: readonly string[];
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  outputEncoding?: CommandOutputEncoding;
  stdin?: Buffer | string;
}

export function runCommand(
  options: RunCommandOptions & { outputEncoding: "buffer" },
): Promise<CommandResult<Buffer>>;
export function runCommand(
  options: RunCommandOptions & { outputEncoding?: "utf8" },
): Promise<CommandResult<string>>;
export function runCommand(
  options: RunCommandOptions,
): Promise<CommandResult<Buffer> | CommandResult<string>> {
  const outputEncoding = options.outputEncoding ?? "utf8";

  return new Promise((resolve, reject) => {
    const child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdoutBuffers: Buffer[] = [];
    let stderr = "";
    let stdout = "";

    if (!child.stdout || !child.stderr) {
      reject(new Error(`${options.command} output streams were not captured.`));
      return;
    }

    if (outputEncoding === "buffer") {
      child.stdout.on("data", (data: Buffer) => {
        stdoutBuffers.push(data);
      });
    } else {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (data: string) => {
        stdout += data;
      });
    }

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (outputEncoding === "buffer") {
        resolve({
          code,
          signal,
          stderr,
          stdout: Buffer.concat(stdoutBuffers),
        });
        return;
      }

      resolve({
        code,
        signal,
        stderr,
        stdout,
      });
    });

    if (options.stdin !== undefined) {
      if (!child.stdin) {
        reject(new Error(`${options.command} stdin was not piped.`));
        return;
      }

      child.stdin.end(options.stdin);
    }
  });
}
