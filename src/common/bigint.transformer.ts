import { ValueTransformer } from 'typeorm';

/** Postgres returns BIGINT as a string; amounts here (kobo) stay far below Number.MAX_SAFE_INTEGER. */
export const bigintTransformer: ValueTransformer = {
  to: (value?: number | null) => value,
  from: (value?: string | null) => (value === null || value === undefined ? value : Number(value)),
};
