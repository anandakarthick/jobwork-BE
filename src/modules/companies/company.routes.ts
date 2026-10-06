import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { productUpload } from '../../middleware/upload';
import {
  brandsQuerySchema,
  createCompanySchema,
  idParamSchema,
  listCompaniesSchema,
  parseFileNames,
  parseTrainFlags,
  priceListDocParamsSchema,
  promptParamsSchema,
  renameRuleGroupSchema,
  ruleGroupParamsSchema,
  savePromptsSchema,
  statusBodySchema,
  updateCompanySchema,
  updatePriceListSchema,
} from './company.schema';
import * as companyService from './company.service';
import type { StoredFile } from './company.service';
import { trainBrandIntoClaude, trainBrandRulesIntoClaude } from './knowledge.service';

export const companyRouter = Router();

companyRouter.use(requireAuth);

// Keyword prompts of several brands by name (?brands=LK,ABB) — the rule picker
// on Get Quote. Declared before the '/:id' routes so "prompts" isn't taken as an id.
companyRouter.get(
  '/prompts',
  requirePermission('jobwork.view'),
  validate(brandsQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const brands = String(req.query.brands ?? '')
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean);
    res.json(await companyService.listPromptsForBrands(brands));
  }),
);

// ----- Brand (company) price-list documents -----
companyRouter.get(
  '/:id/price-lists',
  requirePermission('companies.view'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    res.json(await companyService.listPriceLists(Number(req.params.id)));
  }),
);

companyRouter.post(
  '/:id/price-lists',
  requirePermission('companies.edit'),
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
      await companyService.addPriceLists(
        Number(req.params.id),
        stored,
        req.user!.sub,
        parseTrainFlags(req.body?.train),
        parseFileNames(req.body?.names),
      ),
    );
  }),
);

// Train one file into Claude (Files API) — knowledge-in-Claude engine.
companyRouter.post(
  '/:id/price-lists/:docId/train-claude',
  requirePermission('companies.edit'),
  validate(priceListDocParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    res.status(202).json(
      await companyService.trainPriceListIntoClaude(Number(req.params.id), Number(req.params.docId)),
    );
  }),
);

// Train every ticked file of the brand into Claude.
companyRouter.post(
  '/:id/train-claude',
  requirePermission('companies.edit'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const count = await trainBrandIntoClaude(Number(req.params.id));
    res.status(202).json({ started: count });
  }),
);

// Rename one file and/or switch its training on/off.
companyRouter.patch(
  '/:id/price-lists/:docId',
  requirePermission('companies.edit'),
  validate(priceListDocParamsSchema, 'params'),
  validate(updatePriceListSchema),
  asyncHandler(async (req, res) => {
    res.json(
      await companyService.updatePriceList(
        Number(req.params.id),
        Number(req.params.docId),
        req.body,
      ),
    );
  }),
);

// ----- Brand keyword prompts -----
companyRouter.get(
  '/:id/prompts',
  requirePermission('companies.view'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    res.json(await companyService.listPrompts(Number(req.params.id)));
  }),
);

// Train every rule of the brand into Claude (declared before '/:id/prompts/:promptId').
companyRouter.post(
  '/:id/prompts/train-claude',
  requirePermission('companies.edit'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    res.status(202).json({ started: await trainBrandRulesIntoClaude(Number(req.params.id)) });
  }),
);

// Train one rule into Claude.
companyRouter.post(
  '/:id/prompts/:promptId/train-claude',
  requirePermission('companies.edit'),
  validate(promptParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    res
      .status(202)
      .json(await companyService.trainPromptIntoClaude(Number(req.params.id), Number(req.params.promptId)));
  }),
);

// Give the brand's ungrouped rules a group of their own (brand view page).
companyRouter.post(
  '/:id/rule-groups',
  requirePermission('companies.edit'),
  validate(idParamSchema, 'params'),
  validate(renameRuleGroupSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await companyService.groupUngroupedRules(Number(req.params.id), req.body));
  }),
);

// Rename one rule group in place (brand view page).
companyRouter.patch(
  '/:id/rule-groups/:groupId',
  requirePermission('companies.edit'),
  validate(ruleGroupParamsSchema, 'params'),
  validate(renameRuleGroupSchema),
  asyncHandler(async (req, res) => {
    res.json(
      await companyService.renameRuleGroup(Number(req.params.id), Number(req.params.groupId), req.body),
    );
  }),
);

// Save the whole list at once (add / edit / remove rows).
companyRouter.put(
  '/:id/prompts',
  requirePermission('companies.edit'),
  validate(idParamSchema, 'params'),
  validate(savePromptsSchema),
  asyncHandler(async (req, res) => {
    res.json(await companyService.savePrompts(Number(req.params.id), req.body));
  }),
);

companyRouter.get(
  '/:id/price-lists/:docId/download',
  requirePermission('companies.view'),
  validate(priceListDocParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const doc = await companyService.getPriceListForDownload(
      Number(req.params.id),
      Number(req.params.docId),
    );
    res.download(doc.storagePath, doc.fileName);
  }),
);

// The text extracted from the file, as a .txt download.
companyRouter.get(
  '/:id/price-lists/:docId/text',
  requirePermission('companies.view'),
  validate(priceListDocParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { fileName, text } = await companyService.getPriceListText(
      Number(req.params.id),
      Number(req.params.docId),
    );
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.attachment(`${fileName}.txt`);
    res.send(text);
  }),
);

companyRouter.delete(
  '/:id/price-lists/:docId',
  requirePermission('companies.edit'),
  validate(priceListDocParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    await companyService.deletePriceList(Number(req.params.id), Number(req.params.docId));
    res.status(204).send();
  }),
);

companyRouter.get(
  '/',
  requirePermission('companies.view'),
  validate(listCompaniesSchema, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await companyService.listCompanies(req.query as never));
  }),
);

companyRouter.get(
  '/:id',
  requirePermission('companies.view'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    res.json(await companyService.getCompany(Number(req.params.id)));
  }),
);

companyRouter.post(
  '/',
  requirePermission('companies.create'),
  validate(createCompanySchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await companyService.createCompany(req.body, req.user!.sub));
  }),
);

companyRouter.put(
  '/:id',
  requirePermission('companies.edit'),
  validate(idParamSchema, 'params'),
  validate(updateCompanySchema),
  asyncHandler(async (req, res) => {
    res.json(await companyService.updateCompany(Number(req.params.id), req.body));
  }),
);

// Quick Activate/Deactivate toggle.
companyRouter.patch(
  '/:id/status',
  requirePermission('companies.edit'),
  validate(idParamSchema, 'params'),
  validate(statusBodySchema),
  asyncHandler(async (req, res) => {
    res.json(await companyService.setStatus(Number(req.params.id), req.body.status));
  }),
);

companyRouter.delete(
  '/:id',
  requirePermission('companies.delete'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    await companyService.deleteCompany(Number(req.params.id));
    res.status(204).send();
  }),
);
