import {
  createInteractiveTerminal,
  InteractiveTerminalError,
  type InteractiveTerminal,
} from "./terminal.js";
import type { WarningConfirmationPhase } from "../transcript/index.js";

export interface WarningConfirmationRequest {
  phase: WarningConfirmationPhase;
  warningCount: number;
}

export type WarningConfirmer = (
  request: WarningConfirmationRequest,
) => Promise<boolean>;

interface TerminalWarningConfirmerOptions {
  terminal?: InteractiveTerminal;
}

export class WarningConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export function createTerminalWarningConfirmer(
  options: TerminalWarningConfirmerOptions = {},
): WarningConfirmer {
  const terminal = options.terminal ?? createInteractiveTerminal();

  return async (request) => {
    try {
      return terminal.confirm("Continue with push?");
    } catch (error) {
      if (error instanceof InteractiveTerminalError) {
        throw new WarningConfirmationError(
          `Warning confirmation required for ${request.phase}, but no interactive terminal is available.`,
        );
      }

      throw error;
    }
  };
}
