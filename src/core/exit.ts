export const ExitCode = {
  Ok: 0,
  UserError: 1,
  RemoteFailure: 2,
  RollbackFailed: 3,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export class DbmError extends Error {
  readonly exitCode: ExitCode;
  readonly step: string | undefined;
  constructor(message: string, exitCode: ExitCode, step?: string) {
    super(message);
    this.name = 'DbmError';
    this.exitCode = exitCode;
    this.step = step;
  }
}

export function userError(message: string, step?: string): DbmError {
  return new DbmError(message, ExitCode.UserError, step);
}

export function remoteError(message: string, step: string): DbmError {
  return new DbmError(message, ExitCode.RemoteFailure, step);
}
