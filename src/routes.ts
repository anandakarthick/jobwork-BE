import { Router } from 'express';
import { authRouter } from './modules/auth/auth.routes';
import { categoryRouter } from './modules/categories/category.routes';
import { companyRouter } from './modules/companies/company.routes';
import { customerRouter } from './modules/customers/customer.routes';
import { emailRouter } from './modules/email/email.routes';
import { jobworkRouter } from './modules/jobwork/jobwork.routes';
import { priceListRouter } from './modules/price-list/price-list.routes';
import { quoteRouter } from './modules/quote/quote.routes';
import { roleRouter } from './modules/roles/role.routes';
import { userRouter } from './modules/users/user.routes';
import { settingsRouter } from './modules/settings/settings.routes';

export const apiRouter = Router();

apiRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

apiRouter.use('/auth', authRouter);
apiRouter.use('/categories', categoryRouter);
apiRouter.use('/companies', companyRouter);
apiRouter.use('/customers', customerRouter);
apiRouter.use('/email', emailRouter);
apiRouter.use('/jobwork', jobworkRouter);
apiRouter.use('/price-list', priceListRouter);
apiRouter.use('/quotes', quoteRouter);
apiRouter.use('/roles', roleRouter);
apiRouter.use('/users', userRouter);
apiRouter.use('/settings', settingsRouter);
