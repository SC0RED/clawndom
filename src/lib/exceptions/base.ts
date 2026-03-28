/**
 * Base exception classes for clawndom.
 *
 * Uses Template Method Pattern and Registry Pattern for
 * structured, type-safe error handling.
 */

type ClawndomErrorClass = new (...args: never[]) => ClawndomError;

const errorRegistry = new Map<string, ClawndomErrorClass>();

export abstract class ClawndomError extends Error {
  static readonly errorCode: string;
  static readonly httpStatus: number;

  readonly errorCode: string;
  readonly httpStatus: number;
  readonly context: Record<string, unknown>;

  constructor(message: string, options?: { context?: Record<string, unknown> }) {
    super(message);
    this.name = this.constructor.name;
    this.context = options?.context ?? {};

    const ctor = this.constructor as typeof ClawndomError;
    this.errorCode = ctor.errorCode;
    this.httpStatus = ctor.httpStatus;
  }

  toDict(): Record<string, unknown> {
    return {
      errorCode: this.errorCode,
      message: this.message,
      context: this.context,
    };
  }

  toLogDict(): Record<string, unknown> {
    return {
      errorCode: this.errorCode,
      httpStatus: this.httpStatus,
      message: this.message,
      context: this.context,
      exceptionType: this.name,
    };
  }

  static getByErrorCode(errorCode: string): ClawndomErrorClass | undefined {
    return errorRegistry.get(errorCode);
  }

  override toString(): string {
    if (Object.keys(this.context).length > 0) {
      return `${this.message} (context: ${JSON.stringify(this.context)})`;
    }
    return this.message;
  }
}

export function registerError<T extends ClawndomErrorClass>(errorClass: T): T {
  const code = (errorClass as unknown as typeof ClawndomError).errorCode;
  errorRegistry.set(code, errorClass);
  return errorClass;
}
