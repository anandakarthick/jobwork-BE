import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import {
  updateAppSchema,
  updateLetterheadSchema,
  updateLlmSchema,
  updateSmtpSchema,
} from './settings.schema';
import * as settingsService from './settings.service';
import * as promptService from '../prompts/prompt.service';

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

// AI prompts the quote pipeline runs with — stored in the table, editable here.
settingsRouter.get(
  '/prompts',
  requirePermission('settings.view'),
  asyncHandler(async (_req, res) => {
    res.json(await promptService.listPrompts());
  }),
);

settingsRouter.put(
  '/prompts/:key',
  requirePermission('settings.edit'),
  asyncHandler(async (req, res) => {
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    res.json(await promptService.updatePrompt(String(req.params.key), content));
  }),
);

settingsRouter.post(
  '/prompts/:key/reset',
  requirePermission('settings.edit'),
  asyncHandler(async (req, res) => {
    res.json(await promptService.resetPrompt(String(req.params.key)));
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

