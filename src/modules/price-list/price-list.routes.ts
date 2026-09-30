import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import {
  candidatesSchema,
  docIdParamSchema,
  listItemsSchema,
  setKindSchema,
} from './price-list.schema';
import * as priceListService from './price-list.service';
import { findCandidates } from './price-list.retrieval';

/**
 * Price-list ingestion routes. A ProductDocument is first marked as a
 * PRICE_LIST (with its brand), then ingested into structured price_list_items.
 * Gated behind the same permission as editing the catalogue.
 */
export const priceListRouter = Router();

priceListRouter.use(requireAuth);

// Status of every price-list ingest (for the background-job watcher / notifier).
priceListRouter.get(
  '/ingest-jobs',
  requirePermission('categories.view'),
  asyncHandler(async (_req, res) => {
    res.json(await priceListService.listIngestJobs());
  }),
);

// Mark a document's kind/brand (e.g. flag it as the LK price list).
priceListRouter.patch(
  '/documents/:docId',
  requirePermission('categories.edit'),
  validate(docIdParamSchema, 'params'),
  validate(setKindSchema),
  asyncHandler(async (req, res) => {
    res.json(await priceListService.setDocumentKind(Number(req.params.docId), req.body));
  }),
);

// Trigger ingestion (parse PDF -> price_list_items).
priceListRouter.post(
  '/documents/:docId/ingest',
  requirePermission('categories.edit'),
  validate(docIdParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    res.json(await priceListService.ingestDocument(Number(req.params.docId)));
  }),
);

// Inspect the parsed rows for a document.
priceListRouter.get(
  '/documents/:docId/items',
  requirePermission('categories.view'),
  validate(docIdParamSchema, 'params'),
  validate(listItemsSchema, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await priceListService.listItems(Number(req.params.docId), req.query as never));
  }),
);

// Retrieve ranked match candidates for a single requirement (RAG step).
priceListRouter.post(
  '/documents/:docId/candidates',
  requirePermission('categories.view'),
  validate(docIdParamSchema, 'params'),
  validate(candidatesSchema),
  asyncHandler(async (req, res) => {
    const candidates = await findCandidates({ documentId: Number(req.params.docId), ...req.body });
    res.json({ candidates });
  }),
);
