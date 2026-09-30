import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import {
  createRoleSchema,
  idParamSchema,
  listRolesSchema,
  updateRoleSchema,
} from './role.schema';
import * as roleService from './role.service';

export const roleRouter = Router();

roleRouter.use(requireAuth);

// The permission catalogue for the role editor.
roleRouter.get(
  '/permissions',
  requirePermission('roles.view'),
  asyncHandler(async (_req, res) => {
    res.json(roleService.getPermissionCatalogue());
  }),
);

roleRouter.get(
  '/',
  requirePermission('roles.view'),
  validate(listRolesSchema, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await roleService.listRoles(req.query as never));
  }),
);

roleRouter.get(
  '/:id',
  requirePermission('roles.view'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    res.json(await roleService.getRole(Number(req.params.id)));
  }),
);

roleRouter.post(
  '/',
  requirePermission('roles.create'),
  validate(createRoleSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await roleService.createRole(req.body));
  }),
);

roleRouter.put(
  '/:id',
  requirePermission('roles.edit'),
  validate(idParamSchema, 'params'),
  validate(updateRoleSchema),
  asyncHandler(async (req, res) => {
    res.json(await roleService.updateRole(Number(req.params.id), req.body));
  }),
);

roleRouter.delete(
  '/:id',
  requirePermission('roles.delete'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    await roleService.deleteRole(Number(req.params.id));
    res.status(204).send();
  }),
);
