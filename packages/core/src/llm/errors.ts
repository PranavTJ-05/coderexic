/** Base class for review-model failures; the worker maps these to job error codes. */
export class ModelError extends Error {}

/** The model call did not finish within the configured deadline. */
export class ModelTimeoutError extends ModelError {
  constructor(message = 'model call timed out') {
    super(message);
    this.name = 'ModelTimeoutError';
  }
}

/** The provider returned a non-retryable HTTP error, or retries were exhausted. */
export class ModelHttpError extends ModelError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ModelHttpError';
  }
}

/** The model's response did not parse as JSON or failed the finding schema. */
export class ModelInvalidOutputError extends ModelError {
  constructor(
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ModelInvalidOutputError';
  }
}
