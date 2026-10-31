export type FieldErrors = Record<string, string[]>;

/**
 * An error that is safe to show to the client.
 * Anything that is not an AppError is reported as a generic 500.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fieldErrors?: FieldErrors,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, fieldErrors?: FieldErrors) {
    return new AppError(400, 'BAD_REQUEST', message, fieldErrors);
  }
  static unauthorized(message = 'Authentication required') {
    return new AppError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message = 'You do not have permission to do this') {
    return new AppError(403, 'FORBIDDEN', message);
  }
  static notFound(message = 'Resource not found') {
    return new AppError(404, 'NOT_FOUND', message);
  }
  static conflict(message: string) {
    return new AppError(409, 'CONFLICT', message);
  }
}
