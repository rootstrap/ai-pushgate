import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, writeSync } from "node:fs";

export interface InteractiveTerminal {
  choose?(
    question: string,
    choices: readonly InteractiveTerminalChoice[],
  ): number;
  confirm(question: string): boolean;
  prompt?(question: string): string;
}

export interface InteractiveTerminalChoice {
  detail?: string;
  label: string;
}

interface TerminalFileDescriptors {
  close(): void;
  inputFd: number;
  outputFd: number;
}

interface TerminalRawMode {
  restore(): void;
}

interface TerminalDevicePath {
  input: string;
  output: string;
}

const pendingInputByFd = new Map<number, string>();

export class InteractiveTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export function createInteractiveTerminal(): InteractiveTerminal {
  return {
    choose(question, choices) {
      return chooseWithInteractiveTerminal(question, choices);
    },
    confirm(question) {
      return confirmWithInteractiveTerminal(question);
    },
    prompt(question) {
      return promptWithInteractiveTerminal(question);
    },
  };
}

function chooseWithInteractiveTerminal(
  question: string,
  choices: readonly InteractiveTerminalChoice[],
): number {
  if (choices.length === 0) {
    throw new InteractiveTerminalError("No terminal choices were available.");
  }

  let terminal: TerminalFileDescriptors | undefined;

  try {
    terminal = openInteractiveTerminal();
    const rawMode = enableRawMode(terminal.inputFd);

    try {
      return chooseWithKeyNavigation(terminal, question, choices);
    } finally {
      rawMode.restore();
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

function chooseWithKeyNavigation(
  terminal: TerminalFileDescriptors,
  question: string,
  choices: readonly InteractiveTerminalChoice[],
): number {
  let selectedIndex = 0;
  let renderedLineCount = 0;
  let numericInput = "";
  let message: string | undefined;

  const render = () => {
    renderedLineCount = renderChoicePrompt({
      choices,
      message,
      numericInput,
      outputFd: terminal.outputFd,
      previousLineCount: renderedLineCount,
      question,
      selectedIndex,
    });
  };

  render();

  for (;;) {
    const key = readChoiceKey(terminal.inputFd);

    switch (key.kind) {
      case "up":
        selectedIndex = (selectedIndex - 1 + choices.length) % choices.length;
        numericInput = "";
        message = undefined;
        render();
        break;
      case "down":
        selectedIndex = (selectedIndex + 1) % choices.length;
        numericInput = "";
        message = undefined;
        render();
        break;
      case "digit":
        numericInput += key.value;
        message = undefined;
        render();
        break;
      case "backspace":
        numericInput = numericInput.slice(0, -1);
        message = undefined;
        render();
        break;
      case "enter": {
        if (!numericInput) {
          clearChoicePrompt(terminal.outputFd, renderedLineCount);
          return selectedIndex;
        }

        const selected = Number.parseInt(numericInput, 10);

        if (selected >= 1 && selected <= choices.length) {
          clearChoicePrompt(terminal.outputFd, renderedLineCount);
          return selected - 1;
        }

        message = `Please enter a number from 1 to ${String(choices.length)}.`;
        numericInput = "";
        render();
        break;
      }
      case "interrupt":
        throw new InteractiveTerminalError("Terminal input was interrupted.");
      case "ignored":
        break;
    }
  }
}

function renderChoicePrompt(options: {
  choices: readonly InteractiveTerminalChoice[];
  message: string | undefined;
  numericInput: string;
  outputFd: number;
  previousLineCount: number;
  question: string;
  selectedIndex: number;
}): number {
  const lines = [
    options.question,
    ...options.choices.map((choice, index) => {
      const detail = choice.detail ? ` - ${choice.detail}` : "";
      const marker = index === options.selectedIndex ? ">" : " ";
      return `${marker} ${String(index + 1)}. ${choice.label}${detail}`;
    }),
    "Use Up/Down arrows, Enter to select, or type a number.",
  ];

  if (options.numericInput) {
    lines.push(`Selection: ${options.numericInput}`);
  }

  if (options.message) {
    lines.push(options.message);
  }

  rewriteTerminalBlock(options.outputFd, options.previousLineCount, lines);
  return lines.length;
}

function rewriteTerminalBlock(
  outputFd: number,
  previousLineCount: number,
  lines: readonly string[],
): void {
  if (previousLineCount > 0) {
    writeSync(outputFd, `\u001B[${String(previousLineCount)}A`);
  }

  for (const line of lines) {
    writeSync(outputFd, `\r\u001B[2K${line}\n`);
  }

  for (let index = lines.length; index < previousLineCount; index += 1) {
    writeSync(outputFd, "\r\u001B[2K\n");
  }

  if (previousLineCount > lines.length) {
    writeSync(outputFd, `\u001B[${String(previousLineCount - lines.length)}A`);
  }
}

function clearChoicePrompt(outputFd: number, lineCount: number): void {
  if (lineCount === 0) {
    return;
  }

  writeSync(outputFd, `\u001B[${String(lineCount)}A`);

  for (let index = 0; index < lineCount; index += 1) {
    writeSync(outputFd, "\r\u001B[2K\n");
  }

  writeSync(outputFd, `\u001B[${String(lineCount)}A`);
}

type ChoiceKey =
  | { kind: "backspace" }
  | { kind: "digit"; value: string }
  | { kind: "down" }
  | { kind: "enter" }
  | { kind: "ignored" }
  | { kind: "interrupt" }
  | { kind: "up" };

function readChoiceKey(fd: number): ChoiceKey {
  const char = readCharSync(fd);

  if (char === null) {
    throw new InteractiveTerminalError("No terminal input was available.");
  }

  if (char === "\u0003") {
    return { kind: "interrupt" };
  }

  if (char === "\n") {
    return { kind: "enter" };
  }

  if (char === "\r") {
    consumeOptionalLfAfterCarriageReturn(fd);
    return { kind: "enter" };
  }

  if (char === "\u007F" || char === "\b") {
    return { kind: "backspace" };
  }

  if (/^\d$/.test(char)) {
    return { kind: "digit", value: char };
  }

  if (char === "\u001B") {
    const second = readCharSync(fd);

    if (second === "[") {
      const third = readCharSync(fd);

      if (third === "A") {
        return { kind: "up" };
      }

      if (third === "B") {
        return { kind: "down" };
      }
    }

    if (second === "O") {
      const third = readCharSync(fd);

      if (third === "A") {
        return { kind: "up" };
      }

      if (third === "B") {
        return { kind: "down" };
      }
    }
  }

  return { kind: "ignored" };
}

function enableRawMode(fd: number): TerminalRawMode {
  if (process.platform === "win32") {
    return noopRawMode();
  }

  const state = spawnSync("stty", ["-g"], {
    encoding: "utf8",
    stdio: [fd, "pipe", "ignore"],
  });

  if (state.status !== 0 || state.error || !state.stdout.trim()) {
    return noopRawMode();
  }

  const savedState = state.stdout.trim();
  const raw = spawnSync("stty", ["raw", "-echo"], {
    stdio: [fd, "ignore", "ignore"],
  });

  if (raw.status !== 0 || raw.error) {
    return noopRawMode();
  }

  return {
    restore() {
      spawnSync("stty", [savedState], {
        stdio: [fd, "ignore", "ignore"],
      });
    },
  };
}

function noopRawMode(): TerminalRawMode {
  return {
    restore() {
      // Nothing to restore.
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
        "Please answer `y` or `n`.\n",
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

function promptWithInteractiveTerminal(question: string): string {
  let terminal: TerminalFileDescriptors | undefined;

  try {
    terminal = openInteractiveTerminal();
    writeSync(terminal.outputFd, `${question} `);
    return readLineSync(terminal.inputFd).trim();
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
  return `${question} [y/N] `;
}

function normalizeAnswer(answer: string): "yes" | "no" | "invalid" {
  const normalized = answer.trim().toLowerCase();

  if (normalized === "y" || normalized === "yes") {
    return "yes";
  }

  if (normalized === "" || normalized === "n" || normalized === "no") {
    return "no";
  }

  return "invalid";
}

function readLineSync(fd: number): string {
  let line = "";

  for (;;) {
    const char = readCharSync(fd);

    if (char === null) {
      throw new InteractiveTerminalError("No terminal input was available.");
    }

    if (char === "\n") {
      return line;
    }

    if (char === "\r") {
      consumeOptionalLfAfterCarriageReturn(fd);
      return line;
    }

    line += char;
  }
}

function consumeOptionalLfAfterCarriageReturn(fd: number): void {
  const char = readCharSync(fd);

  if (char === "\n" || char === null) {
    return;
  }

  pendingInputByFd.set(fd, char);
}

function readCharSync(fd: number): string | null {
  const pendingChar = pendingInputByFd.get(fd);

  if (pendingChar !== undefined) {
    pendingInputByFd.delete(fd);
    return pendingChar;
  }

  const buffer = Buffer.alloc(1);
  const bytesRead = readSync(fd, buffer, 0, buffer.length, null);

  if (bytesRead === 0) {
    return null;
  }

  return buffer.toString("utf8", 0, bytesRead);
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

  pendingInputByFd.delete(fd);

  try {
    closeSync(fd);
  } catch {
    // The prompt is already complete; close failures should not mask its result.
  }
}
