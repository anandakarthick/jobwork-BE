import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { productUpload } from '../../middleware/upload';
import {
  createCategorySchema,
  idParamSchema,
  listCategoriesSchema,
  updateCategorySchema,
} from './category.schema';
import * as categoryService from './category.service';
import type { StoredFile } from './category.service';

export const categoryRouter = Router();

const docParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  docId: z.coerce.number().int().positive(),
});

categoryRouter.use(requireAuth);

categoryRouter.get(
  '/',
  requirePermission('categories.view'),
  validate(listCategoriesSchema, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await categoryService.listCategories(req.query as never));
  }),
);

categoryRouter.get(
  '/:id',
  requirePermission('categories.view'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    res.json(await categoryService.getCategory(Number(req.params.id)));
  }),
);

categoryRouter.post(
  '/',
  requirePermission('categories.create'),
  validate(createCategorySchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await categoryService.createCategory(req.body, req.user!.sub));
  }),
);

categoryRouter.put(
  '/:id',
  requirePermission('categories.edit'),
  validate(idParamSchema, 'params'),
  validate(updateCategorySchema),
  asyncHandler(async (req, res) => {
    res.json(await categoryService.updateCategory(Number(req.params.id), req.body));
  }),
);

categoryRouter.delete(
  '/:id',
  requirePermission('categories.delete'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    await categoryService.deleteCategory(Number(req.params.id));
    res.status(204).send();
  }),
);

// ---------- Documents ----------

categoryRouter.get(
  '/:id/documents',
  requirePermission('categories.view'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    res.json(await categoryService.listDocuments(Number(req.params.id)));
  }),
);

categoryRouter.post(
  '/:id/documents',
  requirePermission('categories.edit'),
  validate(idParamSchema, 'params'),
  productUpload.array('documents', 20),
  asyncHandler(async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const stored: StoredFile[] = files.map((f) => ({
      originalName: f.originalname,
      storedName: f.filename,
      mimeType: f.mimetype,
      sizeBytes: f.size,
      path: f.path,
    }));
    res.status(201).json(
      await categoryService.addDocuments(Number(req.params.id), stored, req.user!.sub),
    );
  }),
);

categoryRouter.get(
  '/:id/documents/:docId/download',
  requirePermission('categories.view'),
  validate(docParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const doc = await categoryService.getDocumentForDownload(
      Number(req.params.id),
      Number(req.params.docId),
    );
    res.download(doc.storagePath, doc.fileName);
  }),
);

categoryRouter.delete(
  '/:id/documents/:docId',
  requirePermission('categories.edit'),
  validate(docParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    await categoryService.deleteDocument(Number(req.params.id), Number(req.params.docId));
    res.status(204).send();
  }),
);
