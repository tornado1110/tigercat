export class TigerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TigerError";
    this.code = code;
  }
}

export function isTigerError(error: unknown): error is TigerError {
  return error instanceof TigerError;
}
