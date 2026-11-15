import { QueryFailedError } from 'typeorm';

const PG_UNIQUE_VIOLATION = '23505';

type PgQueryFailedError = QueryFailedError & {
  code?: string;
  detail?: string;
};

/** True when the error is a PostgreSQL unique violation that mentions the given column. */
export function isPgUniqueViolationOnColumn(
  error: unknown,
  column: string,
): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const e: PgQueryFailedError = error;
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes(column)
  );
}
