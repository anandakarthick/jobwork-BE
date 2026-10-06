import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import multer from 'multer';
import { HttpError } from '../lib/http-error';
import { isProduction } from '../config/env';
import { describeLlmError } from '../lib/llm/errors';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.statusCode).json({ message: err.message, details: err.details });
  }

  // AI provider failures (no credit, bad key, rate limit, overloaded…) — tell the
  // user exactly what the provider said, in plain words, with a 4xx/5xx that fits.
  const llm = describeLlmError(err);
  if (llm) {
    console.error('[llm]', err instanceof Error ? err.message : err);
    return res.status(llm.status).json({ message: llm.message });
  }

  // Upload problems are the user's to fix — say what, not "500".
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_COUNT'
        ? 'Too many files in one upload (max 50). Add them in smaller batches.'
        : `Upload rejected: ${err.message}`;
    return res.status(413).json({ message });
  }
  if (err instanceof Error && /^Unsupported file type/.test(err.message)) {
    return res.status(415).json({ message: `${err.message}. Use PDF, image, Word, Excel, CSV or text.` });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const target = (err.meta?.target as string[] | undefined)?.join(', ') ?? 'field';
      return res.status(409).json({ message: `Duplicate value for ${target}` });
    }
    if (err.code === 'P2025') {
      return res.status(404).json({ message: 'Record not found' });
    }
  }

  console.error(err);
  res.status(500).json({
    message: 'Internal server error',
    ...(isProduction ? {} : { error: err instanceof Error ? err.message : String(err) }),
  });
}
