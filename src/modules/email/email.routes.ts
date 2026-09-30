import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { idParamSchema, listLogsSchema, sendQuoteEmailSchema, sendTestSchema } from './email.schema';
import * as emailService from './email.service';

export const emailRouter = Router();

emailRouter.use(requireAuth);

// -------- Test email (verify SMTP config) --------
// Gated by settings.edit — same as who can change the SMTP settings.
emailRouter.post(
  '/test',
  requirePermission('settings.edit'),
  validate(sendTestSchema),
  asyncHandler(async (req, res) => {
    const to = (req.body.to as string | undefined)?.trim() || req.user!.email;
    res.json(await emailService.sendTestEmail(to));
  }),
);

// -------- Compose / send (from a quote) --------
// Prefill the compose form for a quote (recipient, subject, message).
emailRouter.get(
  '/quote/:id/prefill',
  requirePermission('email.send'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    res.json(await emailService.getQuotePrefill(Number(req.params.id), req.user!.sub));
  }),
);

emailRouter.post(
  '/send',
  requirePermission('email.send'),
  validate(sendQuoteEmailSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await emailService.sendQuoteEmail(req.body, req.user!.sub));
  }),
);

// -------- Sent history (audit) --------
emailRouter.get(
  '/logs',
  requirePermission('email.send'),
  validate(listLogsSchema, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await emailService.listLogs(req.query as never));
  }),
);
