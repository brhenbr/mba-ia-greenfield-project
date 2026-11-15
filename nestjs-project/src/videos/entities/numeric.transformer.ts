import type { ValueTransformer } from 'typeorm';

// Postgres returns bigint and numeric columns as strings; expose them as numbers.
export const numericTransformer: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};
