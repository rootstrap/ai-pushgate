export function repairJsonCandidate(
  value: string,
): { notes: string[]; value: string } | null {
  let repaired = value;
  const notes: string[] = [];

  const strippedListMarker = stripLeadingJsonListMarker(repaired);

  if (strippedListMarker !== repaired) {
    repaired = strippedListMarker;
    notes.push("Stripped a leading list marker before the review JSON.");
  }

  const escapedControlCharacters =
    escapeControlCharactersInJsonStrings(repaired);

  if (escapedControlCharacters !== repaired) {
    repaired = escapedControlCharacters;
    notes.push("Escaped raw control characters inside JSON strings.");
  }

  const removedTrailingCommas = removeTrailingCommasBeforeJsonClose(repaired);

  if (removedTrailingCommas !== repaired) {
    repaired = removedTrailingCommas;
    notes.push("Removed trailing commas from JSON objects/arrays.");
  }

  if (notes.length === 0) {
    return null;
  }

  return {
    notes,
    value: repaired,
  };
}

function stripLeadingJsonListMarker(value: string): string {
  return value.replace(/^\s*[•●▪◦*-]\s*(?=\{)/u, "");
}

function escapeControlCharactersInJsonStrings(value: string): string {
  let changed = false;
  let escaped = false;
  let inString = false;
  let repaired = "";

  for (const character of value) {
    if (!inString) {
      repaired += character;

      if (character === "\"") {
        inString = true;
      }

      continue;
    }

    if (escaped) {
      repaired += character;
      escaped = false;
      continue;
    }

    if (character === "\\") {
      repaired += character;
      escaped = true;
      continue;
    }

    if (character === "\"") {
      repaired += character;
      inString = false;
      continue;
    }

    if (character.charCodeAt(0) < 0x20) {
      changed = true;
      repaired += escapeJsonControlCharacter(character);
      continue;
    }

    repaired += character;
  }

  return changed ? repaired : value;
}

function escapeJsonControlCharacter(character: string): string {
  switch (character) {
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default:
      return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  }
}

function removeTrailingCommasBeforeJsonClose(value: string): string {
  let changed = false;
  let escaped = false;
  let inString = false;
  let repaired = "";

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";

    if (inString) {
      repaired += character;

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
      repaired += character;
      inString = true;
      continue;
    }

    if (character === ",") {
      const nextNonWhitespace = findNextNonJsonWhitespace(value, index + 1);

      if (
        nextNonWhitespace !== null &&
        ["]", "}"].includes(value[nextNonWhitespace] ?? "")
      ) {
        changed = true;
        continue;
      }
    }

    repaired += character;
  }

  return changed ? repaired : value;
}

function findNextNonJsonWhitespace(
  value: string,
  startIndex: number,
): number | null {
  for (let index = startIndex; index < value.length; index += 1) {
    const character = value[index] ?? "";

    if (![" ", "\n", "\r", "\t"].includes(character)) {
      return index;
    }
  }

  return null;
}
