import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import {
  createQuotePromptSchema,
  updateAppSchema,
  updateLetterheadSchema,
  updateLlmSchema,
  updateQuotePromptSchema,
  updateSmtpSchema,
} from './settings.schema';
import * as settingsService from './settings.service';
import { HttpError } from '../../lib/http-error';

export const settingsRouter = Router();

// Public — app branding (name + logo) must load on the login page, before auth.
settingsRouter.get(
  '/app',
  asyncHandler(async (_req, res) => {
    res.json(await settingsService.getAppSettings());
  }),
);

settingsRouter.use(requireAuth);

// Editing branding is role-gated (settings.edit).
settingsRouter.put(
  '/app',
  requirePermission('settings.edit'),
  validate(updateAppSchema),
  asyncHandler(async (req, res) => {
    res.json(await settingsService.updateAppSettings(req.body));
  }),
);

settingsRouter.get(
  '/llm',
  requirePermission('apikeys.view'),
  asyncHandler(async (_req, res) => {
    res.json(await settingsService.getLlmSettings());
  }),
);

// Lightweight status for the header — any authenticated user may read it
// (no key material is returned, only the active provider/model + key-set flag).
settingsRouter.get(
  '/llm/status',
  asyncHandler(async (_req, res) => {
    res.json(await settingsService.getLlmStatus());
  }),
);

settingsRouter.put(
  '/llm',
  requirePermission('apikeys.edit'),
  validate(updateLlmSchema),
  asyncHandler(async (req, res) => {
    res.json(await settingsService.updateLlmSettings(req.body));
  }),
);

// SMTP / email config — view needs settings.view, editing needs settings.edit.
settingsRouter.get(
  '/smtp',
  requirePermission('settings.view'),
  asyncHandler(async (_req, res) => {
    res.json(await settingsService.getSmtpSettings());
  }),
);

settingsRouter.put(
  '/smtp',
  requirePermission('settings.edit'),
  validate(updateSmtpSchema),
  asyncHandler(async (req, res) => {
    res.json(await settingsService.updateSmtpSettings(req.body));
  }),
);

// Letter-pad (letterhead) design — view needs settings.view, edit settings.edit.
settingsRouter.get(
  '/letterhead',
  requirePermission('settings.view'),
  asyncHandler(async (_req, res) => {
    res.json(await settingsService.getLetterhead());
  }),
);

// Built-in sample formats to choose from.
settingsRouter.get(
  '/letterhead/presets',
  requirePermission('settings.view'),
  asyncHandler(async (_req, res) => {
    res.json(settingsService.getLetterheadPresets());
  }),
);

settingsRouter.put(
  '/letterhead',
  requirePermission('settings.edit'),
  validate(updateLetterheadSchema),
  asyncHandler(async (req, res) => {
    res.json(await settingsService.updateLetterhead(req.body));
  }),
);

// ---------- Quote prompt snippets (appended to the extraction prompt) ----------
const promptId = (raw: string | undefined): number => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw HttpError.badRequest('Invalid prompt id');
  return id;
};

settingsRouter.get(
  '/quote-prompts',
  requirePermission('settings.view'),
  asyncHandler(async (_req, res) => {
    res.json(await settingsService.listQuotePrompts());
  }),
);

settingsRouter.post(
  '/quote-prompts',
  requirePermission('settings.edit'),
  validate(createQuotePromptSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await settingsService.createQuotePrompt(req.body));
  }),
);

settingsRouter.put(
  '/quote-prompts/:id',
  requirePermission('settings.edit'),
  validate(updateQuotePromptSchema),
  asyncHandler(async (req, res) => {
    res.json(await settingsService.updateQuotePrompt(promptId(req.params.id), req.body));
  }),
);

settingsRouter.delete(
  '/quote-prompts/:id',
  requirePermission('settings.edit'),
  asyncHandler(async (req, res) => {
    await settingsService.deleteQuotePrompt(promptId(req.params.id));
    res.status(204).end();
  }),
);
