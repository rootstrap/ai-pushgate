export interface ParsedCandidate {
  notes: string[];
  source: string;
  value: string;
}

export function buildCandidates(output: string): ParsedCandidate[] {
  const seen = new Set<string>();
  const candidates: ParsedCandidate[] = [];

  const addCandidate = (value: string, source: string, notes: string[] = []) => {
    const trimmedValue = value.trim();

    if (trimmedValue.length === 0 || seen.has(trimmedValue)) {
      return;
    }

    seen.add(trimmedValue);
    candidates.push({
      notes,
      source,
      value: trimmedValue,
    });
  };

  addCandidate(output, "provider response");

  for (const fencedJson of extractFencedJsonBlocks(output)) {
    addCandidate(fencedJson, "fenced JSON block", [
      "Extracted the review JSON from a fenced code block.",
    ]);
  }

  for (const objectSlice of extractJsonObjectSlices(output)) {
    addCandidate(objectSlice, "embedded JSON object", [
      "Extracted the review JSON from surrounding provider prose.",
    ]);
  }

  return candidates;
}

function extractFencedJsonBlocks(output: string): string[] {
  const matches = output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);

  return [...matches].map((match) => match[1] ?? "");
}

function extractJsonObjectSlices(output: string): string[] {
  const slices: string[] = [];

  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== "{") {
      continue;
    }

    const endIndex = findJsonObjectEnd(output, index);

    if (endIndex === null) {
      continue;
    }

    const sliced = output.slice(index, endIndex + 1);

    if (sliced !== output) {
      slices.push(sliced);
    }
  }

  return slices;
}

function findJsonObjectEnd(value: string, startIndex: number): number | null {
  let depth = 0;
  let escaped = false;
  let inString = false;

  for (let index = startIndex; index < value.length; index += 1) {
    const character = value[index] ?? "";

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === "\\") {
        escaped = true;
        continue;
      }

      if (character === "\"") {
        inString = false;
      }

      continue;
    }

    if (character === "\"") {
      inString = true;
      continue;
    }

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character === "}") {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return null;
}
