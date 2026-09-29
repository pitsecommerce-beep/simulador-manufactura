export type HttpError = Error & { statusCode: number };

export function httpError(statusCode: number, message: string): HttpError {
  return Object.assign(new Error(message), { statusCode });
}
