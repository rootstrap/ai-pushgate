import { ConfigError } from "../config/index.js";
import { ChangedFilePolicyError } from "../path-policy/index.js";
import { SkipControlError } from "../skip-controls.js";

export function writePushgateError(
  stderr: NodeJS.WritableStream,
  error: unknown,
): void {
  if (
    error instanceof ConfigError ||
    error instanceof ChangedFilePolicyError ||
    error instanceof SkipControlError
  ) {
    stderr.write(`[pushgate] ${error.message}\n`);
    return;
  }

  const detail = error instanceof Error ? error.message : String(error);

  stderr.write(`[pushgate] Unexpected Pushgate failure: ${detail}\n`);
}
