import { runCommand } from "../process/run-command.js";

export async function resolveGitRepositoryRoot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const result = await runCommand({
    args: ["rev-parse", "--show-toplevel"],
    command: "git",
    env,
  });

  if (result.code === 0) {
    return result.stdout.trim();
  }

  const stderr = result.stderr.trim();

  throw new Error(
    `Pushgate must run inside a Git repository. git rev-parse exited with ${String(result.code)}.${stderr ? ` ${stderr}` : ""}`,
  );
}
