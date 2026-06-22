export { runLocalAiReview } from "./local-ai-gate.js";
export type { LocalAiRunSummary } from "./local-ai-gate.js";

export {
  buildLocalAiReviewPayload,
  collectLocalAiReviewContext,
} from "./review-context.js";
export {
  BASE_REVIEW_PROMPT,
  renderLocalAiPrompt,
} from "./review-prompt.js";
export {
  AiReviewOutputError,
  normalizeAiReviewObject,
  parseAiReviewOutput,
  type NormalizedAiReviewOutput,
} from "./review-output.js";
export {
  AiReviewFindingSchema,
  AiReviewOutputSchema,
  generateAiReviewOutputJsonSchema,
  validateAiReviewOutputContract,
} from "./review-contract.js";
export type {
  AiReviewContractValidationIssue,
  AiReviewContractValidationResult,
} from "./review-contract.js";
export type {
  AiFinding,
  AiFindingCategory,
  AiFindingConfidence,
  AiFindingSeverity,
  AiFindingSource,
  AiReviewSummary,
  LocalAiFullFileContext,
  LocalAiReviewContext,
  LocalAiReviewPayload,
  RawAiFinding,
  RawAiReviewOutput,
} from "./types.js";
export {
  AI_BLOCKING_CATEGORIES,
  AI_FINDING_CATEGORIES,
  AI_FINDING_CONFIDENCE_LEVELS,
  AI_FINDING_SEVERITIES,
  AI_REVIEW_FINDING_KEYS,
  AI_REVIEW_OUTPUT_SCHEMA_ID,
  AI_REVIEW_OUTPUT_SCHEMA_TITLE,
  AI_REVIEW_OUTPUT_SCHEMA_VERSION,
  AI_REVIEW_TOP_LEVEL_KEYS,
  AI_WARNING_CATEGORIES,
} from "./types.js";
