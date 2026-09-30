import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import {
  createUserSchema,
  idParamSchema,
  listUsersSchema,
  updateUserSchema,
} from './user.schema';
import * as userService from './user.service';

export const userRouter = Router();

userRouter.use(requireAuth);

userRouter.get(
  '/',
  requirePermission('users.view'),
  validate(listUsersSchema, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await userService.listUsers(req.query as never));
  }),
);

userRouter.get(
  '/:id',
  requirePermission('users.view'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    res.json(await userService.getUser(Number(req.params.id)));
  }),
);

userRouter.post(
  '/',
  requirePermission('users.create'),
  validate(createUserSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await userService.createUser(req.body, req.user!.sub));
  }),
);

userRouter.put(
  '/:id',
  requirePermission('users.edit'),
  validate(idParamSchema, 'params'),
  validate(updateUserSchema),
  asyncHandler(async (req, res) => {
    res.json(await userService.updateUser(Number(req.params.id), req.body));
  }),
);

userRouter.delete(
  '/:id',
  requirePermission('users.delete'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    await userService.deleteUser(Number(req.params.id), req.user!.sub);
    res.status(204).send();
  }),
);
