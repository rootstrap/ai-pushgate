import {
  createReadStream,
  createWriteStream,
  openSync,
} from "node:fs";
import { createInterface } from "node:readline/promises";

export type WarningConfirmationPhase =
  | "deterministic checks"
  | "local AI review";

export interface WarningConfirmationRequest {
  phase: WarningConfirmationPhase;
  warningCount: number;
}

export type WarningConfirmer = (
  request: WarningConfirmationRequest,
) => Promise<boolean>;

export class WarningConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export function createTerminalWarningConfirmer(): WarningConfirmer {
  return async (request) => {
    let input: ReturnType<typeof createReadStream> | undefined;
    let output: ReturnType<typeof createWriteStream> | undefined;

    try {
      const inputFd = openSync("/dev/tty", "r");
      const outputFd = openSync("/dev/tty", "w");

      input = createReadStream("/dev/tty", {
        autoClose: true,
        encoding: "utf8",
        fd: inputFd,
      });
      output = createWriteStream("/dev/tty", {
        autoClose: true,
        fd: outputFd,
      });

      const readline = createInterface({ input, output });

      try {
        for (;;) {
          const answer = normalizeAnswer(
            await readline.question(formatWarningPrompt(request)),
          );

          if (answer === "yes") {
            return true;
          }

          if (answer === "no") {
            return false;
          }

          output.write("[pushgate] Please answer yes(y) or no(n).\n");
        }
      } finally {
        readline.close();
      }
    } catch (error) {
      throw new WarningConfirmationError(
        `Warning confirmation required for ${request.phase}, but no interactive terminal is available.`,
      );
    } finally {
      input?.destroy();
      output?.end();
    }
  };
}

export function formatWarningPrompt(
  request: WarningConfirmationRequest,
): string {
  return `[pushgate] ${request.phase} produced ${String(request.warningCount)} warning(s). Continue with warnings? yes(y) / no(n) `;
}

function normalizeAnswer(answer: string): "yes" | "no" | "invalid" {
  const normalized = answer.trim().toLowerCase();

  if (normalized === "y" || normalized === "yes") {
    return "yes";
  }

  if (normalized === "n" || normalized === "no") {
    return "no";
  }

  return "invalid";
}
