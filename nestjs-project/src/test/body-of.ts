import type { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';

/**
 * Awaits a supertest call and returns its body typed as `T`.
 *
 * supertest types `res.body` as `any`. Declaring the expected shape here (usually
 * the response DTO the controller documents) keeps `no-unsafe-*` enabled in specs
 * and makes a contract change fail at compile time instead of passing silently.
 * The cast is a declaration of the contract, not a runtime check: assert the
 * values you care about with `expect`.
 */
export async function bodyOf<T>(
  call: PromiseLike<{ body: unknown }>,
): Promise<T> {
  const response = await call;
  return response.body as T;
}

/** Same as `bodyOf`, for the error body every exception filter produces. */
export const errorBodyOf = (call: PromiseLike<{ body: unknown }>) =>
  bodyOf<ApiErrorEnvelope>(call);
