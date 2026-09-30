import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { jobworkUpload } from '../../middleware/upload';
import {
  chatMessageSchema,
  createAnalysisSchema,
  idParamSchema,
  listAnalysesSchema,
} from './jobwork.schema';
import * as jobworkService from './jobwork.service';
import type { StoredFile } from './jobwork.service';

export const jobworkRouter = Router();

jobworkRouter.use(requireAuth);

jobworkRouter.get(
  '/analyses',
  requirePermission('jobwork.view'),
  validate(listAnalysesSchema, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await jobworkService.listAnalyses(req.query as never));
  }),
);

jobworkRouter.get(
  '/analyses/:id',
  requirePermission('jobwork.view'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    res.json(await jobworkService.getAnalysis(Number(req.params.id)));
  }),
);

// Multipart: customerId/title/instructions fields + `documents` file array.
jobworkRouter.post(
  '/analyses',
  requirePermission('jobwork.create'),
  jobworkUpload.array('documents', 20),
  validate(createAnalysisSchema),
  asyncHandler(async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const stored: StoredFile[] = files.map((f) => ({
      originalName: f.originalname,
      storedName: f.filename,
      mimeType: f.mimetype,
      sizeBytes: f.size,
      path: f.path,
    }));
    const analysis = await jobworkService.createAnalysis(req.body, stored, req.user!.sub);
    res.status(201).json(analysis);
  }),
);

jobworkRouter.post(
  '/analyses/:id/messages',
  requirePermission('jobwork.create'),
  validate(idParamSchema, 'params'),
  validate(chatMessageSchema),
  asyncHandler(async (req, res) => {
    const message = await jobworkService.addMessage(Number(req.params.id), req.body.content);
    res.status(201).json(message);
  }),
);

jobworkRouter.delete(
  '/analyses/:id',
  requirePermission('jobwork.create'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    await jobworkService.deleteAnalysis(Number(req.params.id));
    res.status(204).send();
  }),
);
