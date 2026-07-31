export type RegulaErrorCode =
  | 'NOT_FOUND' // referenced doc does not exist
  | 'EXISTS' // create would clobber an existing doc
  | 'CONFLICT' // a move target already exists
  | 'USAGE' // bad input (empty slug, invalid status)
  | 'INVALID'; // a doc on disk violates the schema

/**
 * A typed, CLI-mappable error. The `code` maps to a ratified exit code at the CLI
 * boundary (USAGE → 64, NOT_FOUND/CONFLICT/EXISTS → 1, INVALID → 1/70 per context).
 */
export class RegulaError extends Error {
  constructor(
    public readonly code: RegulaErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'RegulaError';
  }
}
