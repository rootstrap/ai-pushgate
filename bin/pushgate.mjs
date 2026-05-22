#!/usr/bin/env node

const HOOK_PROTOCOL = "1";
const USAGE = `Usage:
  pushgate hook-protocol
  pushgate pre-push [git-hook-args...]`;

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "hook-protocol":
    if (args.length > 0) {
      fail(`hook-protocol does not accept arguments: ${args.join(" ")}`);
      break;
    }

    process.stdout.write(`${HOOK_PROTOCOL}\n`);
    break;
  case "pre-push":
    drainStdin();
    break;
  default:
    fail(command ? `Unsupported Pushgate command: ${command}` : "Missing Pushgate command.");
}

function fail(message) {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exitCode = 64;
}

function drainStdin() {
  process.stdin.on("error", (error) => {
    const detail = error instanceof Error ? error.message : String(error);

    process.stderr.write(`Failed to read pre-push input: ${detail}\n`);
    process.exitCode = 1;
  });
  // Drain Git hook ref updates. Later runner layers will parse this stream.
  process.stdin.resume();
}
