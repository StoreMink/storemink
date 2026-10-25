export class MinkRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "MinkRequestError";
  }
}

/**
 * The image service was still refusing the request with 429 when the call
 * stopped asking. ★ The same code, words and status as any other provider
 * failure, so a caller that does not look for it behaves exactly as before;
 * a caller that can wait longer than one call's own deadline (the revamp's
 * product photos) may ask again later, which is free: a rate-limited request
 * never reached the model, so it was never billed.
 */
export class MinkImageRateLimitedError extends MinkRequestError {
  constructor(message: string) {
    super("image_provider_unavailable", message, 503);
  }
}

export class MinkAgentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryCount = 0,
  ) {
    super(message);
    this.name = "MinkAgentError";
  }
}

export class MinkToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MinkToolInputError";
  }
}

export class MinkToolTimeoutError extends Error {
  constructor() {
    super("The tool exceeded its execution timeout.");
    this.name = "MinkToolTimeoutError";
  }
}
