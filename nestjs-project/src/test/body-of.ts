import type { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';

/**
 * Returns the body of a supertest response typed as `T`.
 *
 * supertest types `res.body` as `any`. Declaring the expected shape here (usually
 * the response DTO the controller documents) keeps `no-unsafe-*` enabled in specs
 * and makes a contract change fail at compile time instead of passing silently.
 * The cast is a declaration of the contract, not a runtime check: assert the
 * values you care about with `expect`.
 */
export const bodyFrom = <T>(response: { body: unknown }): T =>
  response.body as T;

/** Awaits a supertest call and returns its body typed as `T`. */
export async function bodyOf<T>(
  call: PromiseLike<{ body: unknown }>,
): Promise<T> {
  return bodyFrom<T>(await call);
}

/** Same as `bodyOf`, for the error body every exception filter produces. */
export const errorBodyOf = (call: PromiseLike<{ body: unknown }>) =>
  bodyOf<ApiErrorEnvelope>(call);

/** The machine-readable `error` code of an already awaited error response. */
export const errorCodeOf = (response: { body: unknown }): string =>
  bodyFrom<ApiErrorEnvelope>(response).error;
