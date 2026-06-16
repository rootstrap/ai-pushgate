import { spawn } from "node:child_process";

export interface InheritedCommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface RunInheritedCommandOptions {
  args: readonly string[];
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function runInheritedCommand(
  options: RunInheritedCommandOptions,
): Promise<InheritedCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
}
