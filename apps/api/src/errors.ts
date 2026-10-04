/** Errors returned to API clients as { error, message, details }. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new ApiError(400, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) => new ApiError(422, code, message, details);
export const notFound = (message: string) => new ApiError(404, 'NOT_FOUND', message);
export const unauthorized = (message = 'authentication required') => new ApiError(401, 'UNAUTHORIZED', message);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);
