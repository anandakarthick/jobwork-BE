import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  updateProfileSchema,
} from './auth.schema';
import * as authService from './auth.service';

export const authRouter = Router();

authRouter.post(
  '/forgot-password',
  validate(forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    res.json(await authService.forgotPassword(req.body));
  }),
);

authRouter.post(
  '/reset-password',
  validate(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    res.json(await authService.resetPassword(req.body));
  }),
);

authRouter.post(
  '/register',
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await authService.register(req.body));
  }),
);

authRouter.post(
  '/login',
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    res.json(await authService.login(req.body));
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: await authService.getProfile(req.user!.sub) });
  }),
);

// Update own profile (name / phone).
authRouter.patch(
  '/profile',
  requireAuth,
  validate(updateProfileSchema),
  asyncHandler(async (req, res) => {
    res.json({ user: await authService.updateProfile(req.user!.sub, req.body) });
  }),
);

// Change own password (verifies the current one).
authRouter.post(
  '/change-password',
  requireAuth,
  validate(changePasswordSchema),
  asyncHandler(async (req, res) => {
    res.json(await authService.changePassword(req.user!.sub, req.body));
  }),
);
