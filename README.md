# Jobwork — backend

API for the Jobwork quotation tool: brands with trained price lists, keyword prompts and reference files; customers; AI-generated quotes from a BOQ with a chat to refine them.

Stack: Node 20+, Express, TypeScript, Prisma, MySQL/MariaDB.

## Setup

```bash
npm install
cp .env.example .env        # then edit DATABASE_URL, JWT_SECRET, CORS_ORIGIN
npx prisma migrate deploy   # creates/updates the database schema
npx prisma generate
npm run seed                # optional: admin user (admin@jobwork.local / admin123) + sample data
npm run dev                 # http://localhost:4000
```

The AI provider (OpenAI or Claude) and its API key are set in the app under **Settings → API Keys**; the `.env` values are only a fallback.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with reload (tsx watch) |
| `npm run build` / `npm start` | Compile to `dist/` and run it |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run prisma:migrate` | Create a new migration in development |
| `npm run seed` | Seed the database |

## Layout

- `src/modules/*` — one folder per module (`routes` → `service` → Prisma): auth, companies (brands), customers, quote, price-list, email, settings, users, roles.
- `src/modules/quote/quote.pipeline.ts` — BOQ → extract (AI) → retrieve → match (AI) → price (code).
- `src/modules/price-list/` — price-list training (parser, AI fallback), text extraction and reference lookup.
- `src/lib/llm/` — provider-neutral AI layer (OpenAI / Claude / stub) with usage metering.
- `prisma/` — schema, migrations and seed.
- `uploads/` — uploaded files (ignored by git).
