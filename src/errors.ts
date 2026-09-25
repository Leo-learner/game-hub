export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Record<string, unknown>) {
    super(message);
  }
}
export function fail(status: number, code: string, message: string, details?: Record<string, unknown>): never {
  throw new AppError(status, code, message, details);
}
