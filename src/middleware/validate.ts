import type { NextFunction, Request, Response } from 'express';
import type { ZodSchema } from 'zod';
import { HttpError } from '../lib/http-error';

type Source = 'body' | 'query' | 'params';

/** Validates and replaces req[source] with the parsed value. */
export function validate(schema: ZodSchema, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(
        HttpError.badRequest(
          'Validation failed',
          result.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        ),
      );
    }
    req[source] = result.data as never;
    next();
  };
}
