export interface PrePushHookContext {
  branch?: string;
  remote?: string;
}

export function buildPrePushContext(options: {
  args: readonly string[];
  branch: string | undefined;
}): PrePushHookContext {
  return {
    branch: options.branch,
    remote: options.args[0],
  };
}

const MAX_PRE_PUSH_STDIN_LINE_CHARS = 8 * 1024;

export function parseBranchFromPrePushLine(
  line: string,
): string | undefined {
  const trimmed = line.trim();

  if (!trimmed) {
    return undefined;
  }

  const [localRef] = trimmed.split(/\s+/, 1);

  if (localRef?.startsWith("refs/heads/")) {
    return localRef.slice("refs/heads/".length);
  }

  return undefined;
}

/**
 * Read Git's pre-push stdin incrementally until the first local branch ref is found.
 *
 * Git may provide many ref update lines. This reader keeps one bounded line in
 * memory at a time and ignores later chunks once the branch is known.
 */
export function readPrePushBranchFromStdin(
  stdin: NodeJS.ReadableStream,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    if ((stdin as { isTTY?: boolean }).isTTY) {
      resolve(undefined);
      return;
    }

    let branch: string | undefined;
    let line = "";
    let lineOverflowed = false;

    const parseLine = () => {
      if (branch !== undefined || lineOverflowed) {
        return;
      }

      branch = parseBranchFromPrePushLine(line);
    };

    stdin.setEncoding("utf8");
    stdin.on("error", reject);
    stdin.on("data", (chunk: string) => {
      if (branch !== undefined) {
        return;
      }

      for (const character of chunk) {
        if (character === "\n") {
          if (line.endsWith("\r")) {
            line = line.slice(0, -1);
          }

          parseLine();
          line = "";
          lineOverflowed = false;
          continue;
        }

        if (lineOverflowed) {
          continue;
        }

        if (line.length >= MAX_PRE_PUSH_STDIN_LINE_CHARS) {
          line = "";
          lineOverflowed = true;
          continue;
        }

        line += character;
      }
    });
    stdin.on("end", () => {
      parseLine();
      resolve(branch);
    });
    stdin.resume();
  });
}
