export type HttpError = Error & { statusCode: number; expose: true };

/** Error con estado HTTP y mensaje pensado para el usuario (también para 502 y 503). */
export function httpError(statusCode: number, message: string): HttpError {
  return Object.assign(new Error(message), { statusCode, expose: true as const });
}
