// API errors: a stable `code` the front-end understands, a readable message, and an HTTP status.

const STATUS = {
  VALIDATION_ERROR: 400,
  INVALID_AMOUNT: 400,
  SAME_ACCOUNT: 400,
  CATEGORY_NOT_FOUND: 400,
  RESET_LINK_INVALID: 400,
  INVALID_REQUEST: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  HTTPS_REQUIRED: 403,
  PREMIUM_REQUIRED: 403,
  NOT_FOUND: 404,
  ACCOUNT_NOT_FOUND: 404,
  BUDGET_NOT_FOUND: 404,
  PLAN_NOT_FOUND: 404,
  SUBSCRIPTION_NOT_FOUND: 404,
  GOAL_NOT_FOUND: 404,
  EMAIL_TAKEN: 409,
  ACCOUNT_NOT_EMPTY: 409,
  ACCOUNT_CLOSED: 409,
  INSUFFICIENT_FUNDS: 409,
  TRANSFER_FAILED: 409,
  DUPLICATE_REQUEST: 409,
  PAYMENT_FAILED: 402,
  PAYLOAD_TOO_LARGE: 413,
  ACCOUNT_LOCKED: 429,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
};

export class ApiError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS[code] || 400;
    this.extra = extra;
  }
}

export const validationError = (message) => new ApiError("VALIDATION_ERROR", message);

export function sendError(res, code, message, extra = {}) {
  const error = new ApiError(code, message, extra);
  res.status(error.status).json({ error: { code, message, ...extra } });
}

/** Last middleware: turns every error into JSON, and never sends a stack trace to the browser. */
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
  }
  if (err && err.type === "entity.too.large") {
    return sendError(res, "PAYLOAD_TOO_LARGE", "The request is too large.");
  }
  if (err && (err.type === "entity.parse.failed" || err.type === "encoding.unsupported")) {
    return sendError(res, "INVALID_REQUEST", "The request body is not valid JSON.");
  }
  console.error(JSON.stringify({ level: "error", requestId: req.id, path: req.path, message: err && err.message, stack: err && err.stack }));
  return sendError(res, "SERVER_ERROR", "Something went wrong on our side. Please try again.", { requestId: req.id });
}
