/**
 * Base application error. All custom errors extend this.
 * Includes an HTTP status code for route handlers to use.
 */
export class AppError extends Error {
  /**
   * @param {string} message - Human-readable error message
   * @param {number} [statusCode=500] - HTTP status code
   */
  constructor(message, statusCode = 500) {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode
  }
}

/**
 * Thrown when a consumer's ledger balance is insufficient for an API call.
 * Maps to HTTP 402 Payment Required.
 */
export class InsufficientBalanceError extends AppError {
  constructor() {
    super('Insufficient balance', 402)
    this.name = 'InsufficientBalanceError'
  }
}

/**
 * Thrown when a requested resource (user, route, key, etc.) does not exist.
 * Maps to HTTP 404 Not Found.
 */
export class NotFoundError extends AppError {
  /**
   * @param {string} [resource='Resource'] - Name of the missing resource
   */
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404)
    this.name = 'NotFoundError'
  }
}

/**
 * Thrown when authentication fails or the user lacks permission.
 * Maps to HTTP 401 Unauthorized.
 */
export class UnauthorizedError extends AppError {
  /**
   * @param {string} [message='Unauthorized'] - Custom error message
   */
  constructor(message = 'Unauthorized') {
    super(message, 401)
    this.name = 'UnauthorizedError'
  }
}
