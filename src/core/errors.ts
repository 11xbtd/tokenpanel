export type ErrorCode =
  | 'validation'
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'timeout'
  | 'upstream'
  | 'unsupported'
  | 'not_found'
  | 'internal'

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status = 400,
    public readonly detail?: string,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super('validation', message, 400)
  }
}

export class NotFoundError extends AppError {
  constructor(message = '未找到') {
    super('not_found', message, 404)
  }
}

export function errorCodeOf(error: unknown): ErrorCode {
  return error instanceof AppError ? error.code : 'internal'
}
