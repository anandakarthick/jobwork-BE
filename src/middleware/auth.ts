import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { HttpError } from '../lib/http-error';
import { prisma } from '../lib/prisma';
import { hasPermission } from '../lib/permissions';

/** Minimal claims carried in the JWT. */
export interface TokenPayload {
  sub: number;
  email: string;
}

/** The authenticated user attached to each request (loaded fresh from the DB). */
export interface AuthUser {
  sub: number;
  email: string;
  roleId: number | null;
  roleName: string | null;
  permissions: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Verifies the bearer token AND loads the user's current role/permissions from
 * the DB, so permission changes take effect immediately (no stale tokens).
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(HttpError.unauthorized('Missing bearer token'));
  }

  let payload: TokenPayload;
  try {
    payload = jwt.verify(header.slice(7), env.jwtSecret) as unknown as TokenPayload;
  } catch {
    return next(HttpError.unauthorized('Invalid or expired token'));
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    include: { role: { select: { id: true, name: true, permissions: true } } },
  });
  if (!user) return next(HttpError.unauthorized('User no longer exists'));
  if (!user.isActive) return next(HttpError.forbidden('Account is disabled'));

  req.user = {
    sub: user.id,
    email: user.email,
    roleId: user.role?.id ?? null,
    roleName: user.role?.name ?? null,
    permissions: Array.isArray(user.role?.permissions) ? (user.role!.permissions as string[]) : [],
  };
  next();
}

/** Use after requireAuth to require one of the given permission keys. */
export function requirePermission(...required: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(HttpError.unauthorized());
    const ok = required.some((perm) => hasPermission(req.user!.permissions, perm));
    if (!ok) return next(HttpError.forbidden('You do not have permission to do this'));
    next();
  };
}
