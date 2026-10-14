/**
 * TypeORM's raw query() returns a plain array of rows for SELECT and INSERT, but for UPDATE and DELETE
 * on Postgres it returns [rows, affectedCount]. Wrap any UPDATE ... RETURNING in this to get rows either way.
 */
export function rowsOf<T = any>(result: unknown): T[] {
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') return result[0] as T[];
  return result as T[];
}
