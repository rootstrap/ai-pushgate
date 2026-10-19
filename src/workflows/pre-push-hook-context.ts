export interface PrePushHookContext {
  branch?: string;
  branchUpdates: PrePushBranchUpdate[];
  remote?: string;
}

export interface PrePushBranchUpdate {
  localBranch: string;
  localRef: string;
  localSha: string;
  remoteBranch?: string;
  remoteRef: string;
  remoteSha: string;
}

export interface PrePushInput {
  branchUpdates: PrePushBranchUpdate[];
}

export function buildPrePushContext(options: {
  args: readonly string[];
  branch: string | undefined;
  input?: PrePushInput;
}): PrePushHookContext {
  const branchUpdates = options.input?.branchUpdates ?? [];

  return {
    branch: options.branch ?? branchUpdates[0]?.localBranch,
    branchUpdates,
    remote: options.args[0],
  };
}

const MAX_PRE_PUSH_STDIN_LINE_CHARS = 8 * 1024;

export function parseBranchFromPrePushLine(
  line: string,
): string | undefined {
  return parsePrePushLine(line)?.localBranch;
}

export function parsePrePushLine(line: string): PrePushBranchUpdate | null {
  const trimmed = line.trim();

  if (!trimmed) {
    return null;
  }

  const [localRef, localSha, remoteRef, remoteSha] = trimmed.split(/\s+/, 4);

  if (
    !localRef?.startsWith("refs/heads/") ||
    !localSha ||
    !remoteRef ||
    !remoteSha
  ) {
    return null;
  }

  return {
    localBranch: localRef.slice("refs/heads/".length),
    localRef,
    localSha,
    remoteBranch: remoteRef.startsWith("refs/heads/")
      ? remoteRef.slice("refs/heads/".length)
      : undefined,
    remoteRef,
    remoteSha,
  };
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
  return readPrePushInputFromStdin(stdin).then(
    (input) => input.branchUpdates[0]?.localBranch,
  );
}

export function readPrePushInputFromStdin(
  stdin: NodeJS.ReadableStream,
): Promise<PrePushInput> {
  return new Promise((resolve, reject) => {
    if ((stdin as { isTTY?: boolean }).isTTY) {
      resolve({ branchUpdates: [] });
      return;
    }

    const branchUpdates: PrePushBranchUpdate[] = [];
    let line = "";
    let lineOverflowed = false;

    const parseLine = () => {
      if (lineOverflowed) {
        return;
      }

      const update = parsePrePushLine(line);

      if (update) {
        branchUpdates.push(update);
      }
    };

    stdin.setEncoding("utf8");
    stdin.on("error", reject);
    stdin.on("data", (chunk: string) => {
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
      resolve({ branchUpdates });
    });
    stdin.resume();
  });
}
