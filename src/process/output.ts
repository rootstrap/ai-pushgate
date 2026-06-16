export function appendCapped(
  current: string,
  next: string,
  outputCaptureLimit: number,
): string {
  const combined = current + next;

  if (combined.length <= outputCaptureLimit) {
    return combined;
  }

  return combined.slice(-outputCaptureLimit);
}

export function formatOutputTail(
  stdout: string,
  stderr: string,
  outputTailLimit: number,
): string | undefined {
  const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n");

  if (!output) {
    return undefined;
  }

  if (output.length <= outputTailLimit) {
    return output;
  }

  return output.slice(-outputTailLimit);
}
