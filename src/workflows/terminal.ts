import { closeSync, openSync, readSync, writeSync } from "node:fs";

export interface InteractiveTerminal {
  confirm(question: string): boolean;
}

interface TerminalFileDescriptors {
  close(): void;
  inputFd: number;
  outputFd: number;
}

interface TerminalDevicePath {
  input: string;
  output: string;
}

export class InteractiveTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export function createInteractiveTerminal(): InteractiveTerminal {
  return {
    confirm(question) {
      return confirmWithInteractiveTerminal(question);
    },
  };
}

function confirmWithInteractiveTerminal(question: string): boolean {
  let terminal: TerminalFileDescriptors | undefined;

  try {
    terminal = openInteractiveTerminal();

    for (;;) {
      writeSync(terminal.outputFd, formatYesNoPrompt(question));

      const answer = normalizeAnswer(readLineSync(terminal.inputFd));

      if (answer === "yes") {
        return true;
      }

      if (answer === "no") {
        return false;
      }

      writeSync(
        terminal.outputFd,
        "[pushgate] Please answer yes(y) or no(n).\n",
      );
    }
  } catch (error) {
    if (error instanceof InteractiveTerminalError) {
      throw error;
    }

    throw new InteractiveTerminalError("No interactive terminal is available.");
  } finally {
    terminal?.close();
  }
}

function formatYesNoPrompt(question: string): string {
  return `${question} yes(y) / no(n) `;
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

function readLineSync(fd: number): string {
  const buffer = Buffer.alloc(1);
  let line = "";

  for (;;) {
    const bytesRead = readSync(fd, buffer, 0, buffer.length, null);

    if (bytesRead === 0) {
      throw new InteractiveTerminalError("No terminal input was available.");
    }

    const char = buffer.toString("utf8", 0, bytesRead);

    if (char === "\n" || char === "\r") {
      return line;
    }

    line += char;
  }
}

function openInteractiveTerminal(): TerminalFileDescriptors {
  const attachedTerminal = openAttachedTerminal();

  if (attachedTerminal) {
    return attachedTerminal;
  }

  return openControllingTerminal();
}

function openAttachedTerminal(): TerminalFileDescriptors | null {
  const input = process.stdin as NodeJS.ReadStream & {
    fd?: number;
    isTTY?: boolean;
  };
  const output = process.stdout as NodeJS.WriteStream & {
    fd?: number;
    isTTY?: boolean;
  };

  if (
    input.isTTY === true &&
    output.isTTY === true &&
    typeof input.fd === "number" &&
    typeof output.fd === "number"
  ) {
    return {
      close() {
        // These descriptors are owned by the process.
      },
      inputFd: input.fd,
      outputFd: output.fd,
    };
  }

  return null;
}

function openControllingTerminal(): TerminalFileDescriptors {
  const errors: unknown[] = [];

  for (const candidate of getTerminalDeviceCandidates()) {
    let inputFd: number | undefined;
    let outputFd: number | undefined;

    try {
      inputFd = openSync(candidate.input, "r");
      outputFd = openSync(candidate.output, "w");

      return {
        close() {
          closeFd(inputFd);
          closeFd(outputFd);
        },
        inputFd,
        outputFd,
      };
    } catch (error) {
      closeFd(inputFd);
      closeFd(outputFd);
      errors.push(error);
    }
  }

  throw errors[0] ?? new Error("No terminal device candidates were available.");
}

function getTerminalDeviceCandidates(): TerminalDevicePath[] {
  if (process.platform === "win32") {
    return [
      { input: "CONIN$", output: "CONOUT$" },
      { input: "/dev/tty", output: "/dev/tty" },
    ];
  }

  return [{ input: "/dev/tty", output: "/dev/tty" }];
}

function closeFd(fd: number | undefined): void {
  if (fd === undefined) {
    return;
  }

  try {
    closeSync(fd);
  } catch {
    // The prompt is already complete; close failures should not mask its result.
  }
}
