export type TerminalStatus = "blocked" | "info" | "passed" | "skipped" | "warning";

interface TerminalStyleOptions {
  env?: NodeJS.ProcessEnv;
  stream?: NodeJS.WritableStream;
}

const ANSI = {
  blue: ["\u001B[34m", "\u001B[39m"],
  bold: ["\u001B[1m", "\u001B[22m"],
  dim: ["\u001B[2m", "\u001B[22m"],
  green: ["\u001B[32m", "\u001B[39m"],
  red: ["\u001B[31m", "\u001B[39m"],
  yellow: ["\u001B[33m", "\u001B[39m"],
} as const;

const ASCII_STATUS_SYMBOLS = {
  blocked: "[block]",
  info: "[info]",
  passed: "[ok]",
  skipped: "[skip]",
  warning: "[warn]",
} as const satisfies Record<TerminalStatus, string>;

const UNICODE_STATUS_SYMBOLS = {
  blocked: "x",
  info: "i",
  passed: "\u2713",
  skipped: "-",
  warning: "!",
} as const satisfies Record<TerminalStatus, string>;

const STATUS_COLORS = {
  blocked: "red",
  info: "blue",
  passed: "green",
  skipped: "dim",
  warning: "yellow",
} as const satisfies Record<TerminalStatus, keyof typeof ANSI>;

const LABEL_WIDTH = 18;

export function writeHeader(
  stream: NodeJS.WritableStream,
  lines: readonly string[],
): void {
  for (const line of lines) {
    writeLine(stream, line);
  }

  if (lines.length > 0) {
    writeLine(stream, "");
  }
}

export function writeSection(
  stream: NodeJS.WritableStream,
  title: string,
  options: TerminalStyleOptions = {},
): void {
  writeLine(stream, style(title, "bold", withStream(stream, options)));
}

export function writeResultRow(
  stream: NodeJS.WritableStream,
  status: TerminalStatus,
  label: string,
  detail?: string,
  options: TerminalStyleOptions = {},
): void {
  const styleOptions = withStream(stream, options);
  const symbol = statusSymbol(status, styleOptions);
  const styledSymbol = styleStatus(symbol, status, styleOptions);
  const paddedLabel = label.padEnd(LABEL_WIDTH, " ");
  const suffix = detail ? ` ${detail}` : "";

  writeLine(stream, `  ${styledSymbol} ${paddedLabel}${suffix}`.trimEnd());
}

export function writeDetail(
  stream: NodeJS.WritableStream,
  detail: string,
): void {
  writeLine(stream, `  ${detail}`);
}

export function writeIndentedBlock(
  stream: NodeJS.WritableStream,
  lines: readonly string[],
): void {
  for (const line of lines) {
    writeLine(stream, `    ${line}`);
  }
}

export function writeLine(
  stream: NodeJS.WritableStream,
  line = "",
): void {
  stream.write(`${line}\n`);
}

export function formatCount(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
}

export function humanizeIdentifier(value: string): string {
  const stripped = value.replace(/^(policy|plugin):/, "");
  const words = stripped
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) {
    return value;
  }

  return words
    .map((word, index) =>
      index === 0 ? capitalize(word) : word.toLowerCase(),
    )
    .join(" ");
}

export function capitalize(value: string): string {
  if (value.length === 0) {
    return value;
  }

  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function statusSymbol(
  status: TerminalStatus,
  options: TerminalStyleOptions,
): string {
  return (supportsUnicode(options) ? UNICODE_STATUS_SYMBOLS : ASCII_STATUS_SYMBOLS)[
    status
  ];
}

function styleStatus(
  value: string,
  status: TerminalStatus,
  options: TerminalStyleOptions,
): string {
  return style(value, STATUS_COLORS[status], options);
}

function style(
  value: string,
  color: keyof typeof ANSI,
  options: TerminalStyleOptions,
): string {
  if (!supportsColor(options)) {
    return value;
  }

  const [open, close] = ANSI[color];
  return `${open}${value}${close}`;
}

function supportsColor(options: TerminalStyleOptions): boolean {
  const env = options.env ?? process.env;

  if (env.NO_COLOR !== undefined || env.NODE_DISABLE_COLORS !== undefined) {
    return false;
  }

  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") {
    return true;
  }

  return (options.stream as { isTTY?: boolean } | undefined)?.isTTY === true;
}

function supportsUnicode(options: TerminalStyleOptions): boolean {
  const env = options.env ?? process.env;

  if (env.PUSHGATE_ASCII === "1") {
    return false;
  }

  if ((options.stream as { isTTY?: boolean } | undefined)?.isTTY !== true) {
    return false;
  }

  if (process.platform !== "win32") {
    return env.TERM !== "linux";
  }

  return Boolean(env.WT_SESSION || env.TERMINUS_SUBLIME || env.CI);
}

function withStream(
  stream: NodeJS.WritableStream,
  options: TerminalStyleOptions,
): TerminalStyleOptions {
  return {
    ...options,
    stream: options.stream ?? stream,
  };
}
