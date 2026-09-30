import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/http-error';
import { sendPasswordResetLink } from '../email/email.service';
import type { TokenPayload } from '../../middleware/auth';
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
  UpdateProfileInput,
} from './auth.schema';

const withRole = {
  role: { select: { id: true, name: true, permissions: true } },
} as const;

interface UserWithRole {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  role: { id: number; name: string; permissions: unknown } | null;
}

/** Shape returned to clients — includes role + flattened permission list. */
function toAuthUser(user: UserWithRole) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    role: user.role ? { id: user.role.id, name: user.role.name } : null,
    permissions: Array.isArray(user.role?.permissions) ? (user.role!.permissions as string[]) : [],
  };
}

function signToken(user: { id: number; email: string }): string {
  const payload: TokenPayload = { sub: user.id, email: user.email };
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn } as jwt.SignOptions);
}

export async function register(input: RegisterInput) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw HttpError.conflict('Email is already registered');

  const user = await prisma.user.create({
    data: {
      name: input.name,
      email: input.email,
      password: await bcrypt.hash(input.password, 10),
    },
    include: withRole,
  });

  return { user: toAuthUser(user), token: signToken(user) };
}

export async function login(input: LoginInput) {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    include: withRole,
  });
  if (!user || !(await bcrypt.compare(input.password, user.password))) {
    throw HttpError.unauthorized('Invalid email or password');
  }
  if (!user.isActive) throw HttpError.forbidden('Account is disabled');

  return { user: toAuthUser(user), token: signToken(user) };
}

export async function getProfile(userId: number) {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: withRole });
  if (!user) throw HttpError.notFound('User not found');
  return toAuthUser(user);
}

/** Update the signed-in user's own profile (name / phone). */
export async function updateProfile(userId: number, input: UpdateProfileInput) {
  const data: { name?: string; phone?: string | null } = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.phone !== undefined) data.phone = input.phone ?? null;
  const user = await prisma.user.update({ where: { id: userId }, data, include: withRole });
  return toAuthUser(user);
}

/** Change the signed-in user's password (verifies the current password). */
export async function changePassword(userId: number, input: ChangePasswordInput) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw HttpError.notFound('User not found');
  if (!(await bcrypt.compare(input.currentPassword, user.password))) {
    throw HttpError.badRequest('Your current password is incorrect');
  }
  await prisma.user.update({
    where: { id: userId },
    data: { password: await bcrypt.hash(input.newPassword, 10) },
  });
  return { message: 'Your password has been updated.' };
}

// ---------------------------------------------------------------------------
// Forgot password (email a reset LINK → click → set new password)
// ---------------------------------------------------------------------------

const LINK_TTL_MIN = 30; // reset-link lifetime
const GENERIC_FORGOT_MSG =
  'If an account exists for that email, a password reset link has been sent to it.';

interface ResetTokenPayload {
  sub: number;
  purpose: 'pwreset';
  prid: number; // password_resets.id
}

/** The reset-link URL the email points at (frontend page + signed token). */
function resetUrl(token: string): string {
  const base = env.corsOrigin[0]?.replace(/\/+$/, '') || 'http://localhost:5175';
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}

/**
 * Request a reset — emails a secure, single-use reset LINK (magic link). Always
 * returns the same generic message so the endpoint can't reveal which emails
 * are registered.
 */
export async function forgotPassword(input: ForgotPasswordInput) {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (user && user.isActive) {
    // Invalidate any earlier outstanding links for this user.
    await prisma.passwordReset.updateMany({
      where: { userId: user.id, used: false },
      data: { used: true },
    });

    // The DB row tracks single-use + expiry; the signed link token carries its id.
    const marker = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + LINK_TTL_MIN * 60_000);
    const reset = await prisma.passwordReset.create({
      data: { userId: user.id, otpHash: marker, expiresAt },
    });

    const payload: ResetTokenPayload = { sub: user.id, purpose: 'pwreset', prid: reset.id };
    const token = jwt.sign(payload, env.jwtSecret, { expiresIn: `${LINK_TTL_MIN}m` } as jwt.SignOptions);

    // Best-effort send (never leaks failure to the caller).
    await sendPasswordResetLink({
      to: user.email,
      name: user.name,
      url: resetUrl(token),
      minutes: LINK_TTL_MIN,
    }).catch(() => undefined);
  }
  return { message: GENERIC_FORGOT_MSG };
}

/** Set the new password using the token from the emailed reset link. */
export async function resetPassword(input: ResetPasswordInput) {
  let payload: ResetTokenPayload;
  try {
    payload = jwt.verify(input.resetToken, env.jwtSecret) as unknown as ResetTokenPayload;
  } catch {
    throw HttpError.badRequest('This reset session has expired. Please start again.');
  }
  if (payload.purpose !== 'pwreset') throw HttpError.badRequest('Invalid reset token');

  const reset = await prisma.passwordReset.findUnique({ where: { id: payload.prid } });
  if (!reset || reset.used || reset.userId !== payload.sub || reset.expiresAt <= new Date()) {
    throw HttpError.badRequest('This reset session has expired. Please start again.');
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: payload.sub },
      data: { password: await bcrypt.hash(input.password, 10) },
    }),
    prisma.passwordReset.update({ where: { id: reset.id }, data: { used: true } }),
    // Invalidate any other outstanding codes for this user.
    prisma.passwordReset.updateMany({
      where: { userId: payload.sub, used: false },
      data: { used: true },
    }),
  ]);

  return { message: 'Your password has been reset. You can now sign in.' };
}
