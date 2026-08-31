export type ProgressErrorCode =
  | "invalid_arguments"
  | "invalid_event"
  | "sensitive_content"
  | "bridge_unavailable";

const ERROR_MESSAGES: Readonly<Record<ProgressErrorCode, string>> = {
  invalid_arguments: "invalid command arguments",
  invalid_event: "progress event is invalid",
  sensitive_content: "progress content contains sensitive data",
  bridge_unavailable: "progress bridge is unavailable",
};

const EXIT_CODES: Readonly<Record<ProgressErrorCode, number>> = {
  invalid_arguments: 2,
  invalid_event: 2,
  sensitive_content: 3,
  bridge_unavailable: 4,
};

export class ProgressError extends Error {
  readonly code: ProgressErrorCode;
  readonly exitCode: number;

  constructor(code: ProgressErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ProgressError";
    this.code = code;
    this.exitCode = EXIT_CODES[code];
  }
}

export function normalizeProgressError(error: unknown): ProgressError {
  return error instanceof ProgressError ? error : new ProgressError("invalid_event");
}
