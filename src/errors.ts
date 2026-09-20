import type { StandardSchemaIssue } from "./standard-schema.ts";

export class UnexpectedResponseError extends Error {
  constructor(readonly request: Request, readonly response: Response) {
    super(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
    this.name = "UnexpectedResponseError";
  }
}

export class ResponseValidationError extends Error {
  constructor(
    readonly request: Request,
    readonly response: Response,
    readonly issues: readonly StandardSchemaIssue[],
  ) {
    super("Response failed schema validation");
    this.name = "ResponseValidationError";
  }
}

export class ConcurrentNextError extends Error {
  constructor() {
    super("Concurrent calls to the same next() are not allowed");
    this.name = "ConcurrentNextError";
  }
}
