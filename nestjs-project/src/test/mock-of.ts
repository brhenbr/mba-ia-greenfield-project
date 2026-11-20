import type { InjectionToken } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';

/**
 * Every method of `T` as a `jest.Mock` property typed by that method.
 *
 * `jest.Mocked<T>` keeps the original method signatures, so `expect(mock.method)`
 * trips `@typescript-eslint/unbound-method`. Here the members are plain `jest.Mock`
 * properties, which also makes `mockResolvedValue` check the stubbed value
 * against the method's real return type.
 */
export type MockOf<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? jest.Mock<R, A>
    : T[K];
};

/**
 * Resolves a provider that the testing module replaced with `jest.fn()` members
 * and types it as `MockOf<T>`.
 */
export const mockFor = <T>(
  module: TestingModule,
  token: InjectionToken,
): MockOf<T> => module.get<T, MockOf<T>>(token);
