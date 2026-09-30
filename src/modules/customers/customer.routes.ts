import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import {
  createCustomerSchema,
  idParamSchema,
  listCustomersSchema,
  updateCustomerSchema,
} from './customer.schema';
import * as customerService from './customer.service';

export const customerRouter = Router();

customerRouter.use(requireAuth);

customerRouter.get(
  '/',
  requirePermission('customers.view'),
  validate(listCustomersSchema, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await customerService.listCustomers(req.query as never));
  }),
);

customerRouter.get(
  '/:id',
  requirePermission('customers.view'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    res.json(await customerService.getCustomer(Number(req.params.id)));
  }),
);

customerRouter.post(
  '/',
  requirePermission('customers.create'),
  validate(createCustomerSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await customerService.createCustomer(req.body, req.user!.sub));
  }),
);

customerRouter.put(
  '/:id',
  requirePermission('customers.edit'),
  validate(idParamSchema, 'params'),
  validate(updateCustomerSchema),
  asyncHandler(async (req, res) => {
    res.json(await customerService.updateCustomer(Number(req.params.id), req.body));
  }),
);

customerRouter.delete(
  '/:id',
  requirePermission('customers.delete'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    await customerService.deleteCustomer(Number(req.params.id));
    res.status(204).send();
  }),
);
