import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Configured product categories & supported brands (from the spec sheet).
const categories = [
  { name: 'MCCB (Moulded Case Circuit Breaker)', brands: ['LK', 'Siemens', 'Schneider', 'ABB'] },
  { name: 'Digital Meters', brands: ['LK', 'Siemens', 'Schneider', 'ELMeasure', 'Secure'] },
  { name: 'Protection Relays', brands: ['LK', 'Schneider', 'ABB', 'Siemens', 'Alstom / C&S'] },
  { name: 'Capacitors', brands: ['LK', 'EPCOS', 'Neptune', 'Schneider'] },
  { name: 'ACB', brands: ['LK', 'Siemens', 'Schneider', 'ABB'] },
];

async function main() {
  // Roles. Administrator holds the wildcard "*" (all permissions).
  const adminRole = await prisma.role.upsert({
    where: { name: 'Administrator' },
    update: { permissions: ['*'], isSystem: true },
    create: {
      name: 'Administrator',
      description: 'Full access to everything.',
      permissions: ['*'],
      isSystem: true,
    },
  });

  await prisma.role.upsert({
    where: { name: 'Manager' },
    update: {},
    create: {
      name: 'Manager',
      description: 'Manage catalogue, customers and quotes (no user/role admin).',
      permissions: [
        'dashboard.view',
        'companies.view', 'companies.create', 'companies.edit',
        'categories.view', 'categories.create', 'categories.edit',
        'customers.view', 'customers.create', 'customers.edit',
        'jobwork.view', 'jobwork.create',
        'settings.view',
      ],
    },
  });

  await prisma.role.upsert({
    where: { name: 'Viewer' },
    update: {},
    create: {
      name: 'Viewer',
      description: 'Read-only access.',
      permissions: [
        'dashboard.view',
        'companies.view',
        'categories.view',
        'customers.view',
        'jobwork.view',
      ],
    },
  });

  const admin = await prisma.user.upsert({
    where: { email: 'admin@jobwork.local' },
    update: { roleId: adminRole.id },
    create: {
      name: 'Admin',
      email: 'admin@jobwork.local',
      password: await bcrypt.hash('admin123', 10),
      roleId: adminRole.id,
    },
  });

  for (const category of categories) {
    await prisma.productCategory.upsert({
      where: { name: category.name },
      update: { brands: category.brands },
      create: { name: category.name, brands: category.brands, createdById: admin.id },
    });
  }

  // Every distinct brand across the categories, seeded as an ACTIVE company so
  // they're available in the brand picker.
  const brandCompanies = Array.from(new Set(categories.flatMap((c) => c.brands)));

  for (const name of brandCompanies) {
    await prisma.company.upsert({
      where: { name },
      update: {},
      create: { name, status: 'ACTIVE', createdById: admin.id },
    });
  }

  const customers = [
    {
      name: 'Acme Industries',
      email: 'purchasing@acme.example',
      phone: '+91 98765 43210',
      address: '12 MG Road, Bengaluru, KA 560001',
    },
    {
      name: 'Bharat Electricals',
      email: 'sales@bharatelec.example',
      phone: '+91 91234 56780',
      address: '5 Industrial Estate, Pune, MH 411019',
    },
    {
      name: 'Sunrise Switchgear',
      email: 'info@sunrisesg.example',
      phone: '+91 90000 12345',
      address: null,
    },
    { name: 'Metro Contractors', email: null, phone: '+91 99887 76655', address: null },
  ];

  // `name` isn't unique, so guard with findFirst to stay idempotent on re-seed.
  for (const customer of customers) {
    const existing = await prisma.customer.findFirst({ where: { name: customer.name } });
    if (!existing) {
      await prisma.customer.create({ data: { ...customer, createdById: admin.id } });
    }
  }

  // LLM settings singleton (id=1), seeded from env so existing .env keys carry over.
  await prisma.llmSetting.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      provider: process.env.LLM_PROVIDER || 'stub',
      openaiApiKey: process.env.OPENAI_API_KEY || null,
      openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
      anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
      anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
    },
  });

  console.log('Seed complete. Login: admin@jobwork.local / admin123 (Administrator)');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
