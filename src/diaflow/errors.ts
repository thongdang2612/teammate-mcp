export class DiaflowHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly detail?: unknown;

  constructor(status: number, message: string, opts: { code?: string; detail?: unknown } = {}) {
    super(message);
    this.name = "DiaflowHttpError";
    this.status = status;
    this.code = opts.code;
    this.detail = opts.detail;
  }
}
