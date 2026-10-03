import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { jobworkUpload } from '../../middleware/upload';
import {
  chatMessageSchema,
  createQuoteSchema,
  idParamSchema,
  listQuotesSchema,
  updateQuoteSchema,
} from './quote.schema';
import * as quoteService from './quote.service';
import type { StoredFile } from './quote.service';

export const quoteRouter = Router();

quoteRouter.use(requireAuth);

quoteRouter.get(
  '/',
  requirePermission('jobwork.view'),
  validate(listQuotesSchema, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await quoteService.listQuotes(req.query as never));
  }),
);

quoteRouter.get(
  '/:id',
  requirePermission('jobwork.view'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    res.json(await quoteService.getQuote(Number(req.params.id)));
  }),
);

// Live generation progress — polled while a quote is PROCESSING.
quoteRouter.get(
  '/:id/progress',
  requirePermission('jobwork.view'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    res.json(await quoteService.getQuoteProgress(Number(req.params.id)));
  }),
);

// Multipart: customerId/categoryId/brand/title/defaultDiscountPct + `documents` files.
quoteRouter.post(
  '/',
  requirePermission('jobwork.create'),
  jobworkUpload.array('documents', 20),
  validate(createQuoteSchema),
  asyncHandler(async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const stored: StoredFile[] = files.map((f) => ({
      originalName: f.originalname,
      storedName: f.filename,
      mimeType: f.mimetype,
      sizeBytes: f.size,
      path: f.path,
    }));
    res.status(201).json(await quoteService.createQuote(req.body, stored, req.user!.sub));
  }),
);

// Change the chat's name, customer, brands or selected rules.
quoteRouter.patch(
  '/:id',
  requirePermission('jobwork.create'),
  validate(idParamSchema, 'params'),
  validate(updateQuoteSchema),
  asyncHandler(async (req, res) => {
    res.json(await quoteService.updateQuote(Number(req.params.id), req.body));
  }),
);

// Download the generated quote as .xlsx.
quoteRouter.get(
  '/:id/download',
  requirePermission('jobwork.view'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { buffer, fileName } = await quoteService.buildQuoteXlsx(Number(req.params.id));
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    // Let the browser/axios read the server-chosen filename.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(buffer);
  }),
);

// Continue the quote's chat thread. Multipart: `content` + optional `files`.
quoteRouter.post(
  '/:id/messages',
  requirePermission('jobwork.create'),
  jobworkUpload.array('files', 10),
  validate(idParamSchema, 'params'),
  validate(chatMessageSchema),
  asyncHandler(async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const attachments = files.map((f) => ({
      name: f.originalname,
      path: f.path,
      mimeType: f.mimetype,
    }));
    const content: string = req.body.content ?? '';
    if (!content.trim() && attachments.length === 0) {
      res.status(400).json({ message: 'Type a message or attach a file.' });
      return;
    }
    const message = await quoteService.addQuoteMessage(Number(req.params.id), content, attachments);
    res.status(201).json(message);
  }),
);

quoteRouter.delete(
  '/:id',
  requirePermission('jobwork.create'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    await quoteService.deleteQuote(Number(req.params.id));
    res.status(204).send();
  }),
);
