import assert from "node:assert/strict";
import test from "node:test";

import type { InteractiveTerminal } from "../src/workflows/terminal.js";
import { InteractiveTerminalError } from "../src/workflows/terminal.js";
import {
  createTerminalWarningConfirmer,
  WarningConfirmationError,
} from "../src/workflows/warning-confirmation.js";
import {
  createTerminalReviewTargetSelector,
  REVIEW_TARGET_CONFIG_KEY,
  ReviewTargetSelectionError,
} from "../src/workflows/review-target-selection.js";

test("terminal warning confirmer asks the default-no push question through the terminal", async () => {
  const questions: string[] = [];
  const terminal: InteractiveTerminal = {
    confirm(question) {
      questions.push(question);
      return true;
    },
  };
  const confirmer = createTerminalWarningConfirmer({ terminal });

  const confirmed = await confirmer({
    phase: "deterministic checks",
    warningCount: 1,
  });

  assert.equal(confirmed, true);
  assert.deepEqual(questions, ["Continue with push?"]);
});

test("terminal warning confirmer maps terminal unavailability to a warning confirmation error", async () => {
  const terminal: InteractiveTerminal = {
    confirm() {
      throw new InteractiveTerminalError("No interactive terminal is available.");
    },
  };
  const confirmer = createTerminalWarningConfirmer({ terminal });

  await assert.rejects(
    () =>
      confirmer({
        phase: "local AI review",
        warningCount: 2,
      }),
    (error) => {
      assert.ok(error instanceof WarningConfirmationError);
      assert.match(
        error.message,
        /Warning confirmation required for local AI review, but no interactive terminal is available/,
      );
      return true;
    },
  );
});

test("terminal review target selector fails closed without interactive choice support", async () => {
  const terminal: InteractiveTerminal = {
    confirm() {
      return false;
    },
  };
  const selector = createTerminalReviewTargetSelector({ terminal });

  await assert.rejects(
    () =>
      selector({
        candidates: [
          {
            label: "main",
            ref: "main",
            source: "configured",
          },
        ],
        diagnostics: [],
      }),
    (error) => {
      assert.ok(error instanceof ReviewTargetSelectionError);
      assert.match(error.message, /no interactive terminal is available/);
      assert.match(error.message, new RegExp(REVIEW_TARGET_CONFIG_KEY));
      return true;
    },
  );
});
