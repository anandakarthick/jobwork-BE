# Jobwork — project notes for Claude Code

AI switchgear quote generator: a customer's BOQ (Excel/PDF/Word/image) → priced bill of
materials (Switchgear Report-Board Excel) using the brand's **price lists** and **rules**,
then a chat to question or change the quote.

Two repos, cloned side by side (either naming works, `start.bat` detects both):

| Part | Folder | Stack | Port | GitHub |
|---|---|---|---|---|
| Backend | `backend/` or `jobwork-BE/` | Express + TypeScript (tsx watch), Prisma, MySQL (`jobwork_local`) | 4000 | anandakarthick/jobwork-BE (public) |
| Frontend | `frontend/` or `jobwork-FE/` | Vite + React + TS, Redux, Tailwind | 5175 (proxies `/api` → 4000) | anandakarthick/jobwork-FE (public) |

Both repos are **public** — never commit `.env`, API keys, or an unsanitised DB export
(GitHub push protection has already blocked such pushes twice).

## Run

- `start.bat` in the project root (next to the two folders): checks/installs Node, Python +
  OCR libraries, runs `prisma generate`, starts BE and FE in their own windows, waits for the
  backend, opens the app. `stop.bat` stops both. Servers always run in separate windows —
  never as background shell jobs.
- Do **not** restart the backend while a quote or a training job is running (check
  `quotes.status`, `product_documents.ai_status`, `brand_prompts.ai_status` for PROCESSING).
- Backend hot-reloads code (tsx watch). A Prisma schema change needs `npx prisma migrate deploy`
  + `npx prisma generate` + a backend restart.
- Typecheck before committing: `npx tsc --noEmit -p .` in each repo. No ESLint config.
- DB dump for the repo: `backend/db/jobwork_local.sql` = `mysqldump --skip-comments` of
  `jobwork_local` **excluding** `users`, `password_resets`, `llm_settings`, `smtp_settings`
  (`C:\xampp\mysql\bin\mysqldump.exe`). Regenerate it whenever a migration is added. Other
  `db/*.sql` files are git-ignored.
- Seed admin: `admin@jobwork.local / admin123` (`npm run seed`).

## How a quote works (Claude knowledge engine — the default)

`llm_settings.quote_engine` = `claude` (default) | `database` (older parsed-price-list engine).

1. **Training** (manual, per brand): a price-list PDF's complete text is extracted by
   `backend/scripts/pdf_text.py` (PyMuPDF text layer + RapidOCR for image pages/embedded
   images, cached in `<pdf>.ocr-cache.json`) and uploaded as a text file to the **Anthropic
   Files API** (beta `files-api-2025-04-14`, header `anthropic-workspace-id`). The returned
   `file_…` id is stored on `product_documents.ai_file_id` (+ `ai_status`, `ai_file_chars`,
   `ai_pages`). Each **rule** is uploaded the same way → `brand_prompts.ai_file_id`.
   Nothing from the PDF is parsed into tables. Text only — PDFs themselves are not uploaded.
2. **Quote**: one Claude call with the brand's price-list file ids + the selected rules
   (trained → file id, untrained → inline text) + the BOQ text → JSON boards/items
   (`quote.knowledge.ts: generateWithKnowledge`). `verifyAgainstText` then checks every
   catalogue number and price against the transient PDF text; unconfirmed lines get a blank
   code and "manual verification required". Streaming + segment continuation (32k tokens per
   segment) so long answers are never cut off. ~266k input tokens ≈ $1.75 cold / $0.55 cached.
3. **Chat** (`chatWithKnowledge`): returns `{reply, bom|null, fileName}`. Questions leave the
   BOM; changes replace it. The current BOM is sent in the answer field shape (`catalogNo`,
   `listPrice`, …) and alternative names (`modelNo`, `catalogPrice`, `price`, `quantity`,
   `reason`) are accepted when normalising. `regenerate` rebuilds from the same BOQ.
   One Excel per chat (`Customer-BOQ-date-Qnn.xlsx`); New chat starts with nothing selected.
4. **Prompts** live in the `system_prompts` table (seeded from
   `modules/prompts/prompt.defaults.ts`: `quote.extract.system`, `quote.extract.fields`,
   `quote.accessories.system`, `quote.match.system`, `quote.knowledge.system`,
   `quote.knowledge.chat`). There is no prompt-editing page; brand behaviour is driven by the
   brand's rules.

### Page search (PostgreSQL + pgvector) — cost reduction, off by default

Settings → API Keys → "Send only the matching price-list pages" (`llm_settings.page_search`).
Instead of attaching the whole price-list files, a quote sends only the pages it needs;
same prompts, rules, model and `verifyAgainstText` against the complete files.

- **DB**: PostgreSQL 16 on this PC (port 5433, login in `.env`), database
  `jobwork_vectors`, extensions `vector` 0.8.7 (built from source with VS Build Tools,
  copied into `C:\Program Files\PostgreSQL\16`) + `pg_trgm`. `VECTOR_DATABASE_URL` in `.env`;
  unset = feature off. Tables (`src/lib/vector-db.ts`, created on first use):
  `price_documents`, `price_pages`, `price_chunks` (embedding `vector(768)`, HNSW cosine).
- **Embeddings**: local, free — `scripts/embed.py` (fastembed `BAAI/bge-base-en-v1.5`, model
  cached in `backend/.cache/fastembed`, git-ignored). `pip install fastembed` (start.bat does it).
- **Indexing** happens inside Train / Train again (after the Files API upload, same OCR text):
  pages split on `[page N]`, ~900-char chunks. ~6 min for a 156-page list on CPU.
  `npx tsx scripts/vectors-index.ts [docId…]` indexes already-trained files. A quote uses page
  search only when every brand file's index matches its current `ai_file_id`; otherwise whole files.
- **Selection** (`modules/vectors/vector.select.ts`): (1) PLAN — Claude reads the OUTLINE
  (one line per catalogue *section* = consecutive pages with the same heading line, built from
  the PDF itself) + rules + BOQ and names the sections (prompt `quote.pages.select`, ~23k tokens,
  cached); (2) SEARCH — every BOQ line and rule line is ranked by pgvector + BM25 (fused), sections
  vote, best ones fill the budget (`PAGE_BUDGET_CHARS` 110k ≈ 66k tokens). The plan also returns
  product phrases ("items") that lead the search. (3) FILL-IN — lines left without a product are
  searched by their own words; pages not yet sent go to Claude with the rules and ONLY those lines
  (prompt `quote.pages.fill`, label `quote:pages-fill`), codes are written into the BOM and verified
  again. (Re-asking for the whole BOM was tried and dropped: output is the costly part.) Pages are
  sent as one cached text block, framed by prompt `quote.pages.note`. Chat: pages printing the
  current BOM's codes + search for the message, fill-in for lines a change left open. Nothing brand-
  or product-specific in code — works for any brand's PDF.
- **Status (2026-10-22): experimental, OFF.** Offline coverage of the saved quotes' codes 95.7%.
  Paid A/B on BOQ_dz_double (Opus 5.5, before the fill-in step): priced lines 42 → 35 / 27, cost
  $1.58 (whole-BOM re-ask) / $0.77. The whole-file engine itself varies run to run (quotes 15/16,
  same BOQ: 39 vs 42 priced). Fill-in step and Sonnet 5.5 are built but NOT tested — the user
  stopped paid testing. Next: A/B with fill-in on Opus and on Sonnet 5.5 before switching it on.
- **Checks**: `scripts/vectors-eval.ts [budget] [depth] [plan]` = offline coverage of saved quotes'
  codes (free; `plan` = one paid planner call per quote); `scripts/vectors-ab.ts [quoteId…]` =
  paid A/B of page search vs the saved whole-file BOMs.

### Rules and rule groups

- `brand_rule_groups` (name, sort_order, per brand) → `brand_prompts.group_id`. Rules are
  created **inside a group** on the brand edit page (Add group → Add rule). Older rules with
  `group_id NULL` show under a "No group" card; typing a name there (edit page) or using the
  pencil (view page, `POST /companies/:id/rule-groups`) turns them into a group. Groups can be
  renamed in place (`PATCH /companies/:id/rule-groups/:groupId`).
- `PUT /companies/:id/prompts` saves the whole tree `{groups:[{id?,key,name}],
  prompts:[{id?,name,groupKey|null,content,train}]}` in one transaction; `GET` returns
  `{groups, prompts}`. `GET /companies/prompts?brands=LK` feeds the Get Quote picker (group
  id/name, page order).
- `train` on a rule = **Common** (pre-ticked on Get Quote). Changing a rule's **text** resets
  `ai_status` to NOT_STARTED ("edited — save, then Train again"); moving/renaming does not.
- Get Quote rule picker: brand → group (checkbox ticks the whole group, ▸ folds) → rules.
  The chosen ids are stored in `quotes.prompt_ids`.

## Conventions the user insists on

- **No static product knowledge in code** — no hard-coded series names, word lists or
  examples. Everything comes from the BOQ + the brand's rules + the price list. Fix wrong
  picks by changing rules/prompts, not code.
- **Prompts in the database**, never hard-coded strings.
- **Training is manual** with a confirm dialog (Train / Train again); no auto-train on upload.
- **No `window.alert/confirm/prompt`** — use `confirmDialog` / `alertDialog`
  (`components/ui/Dialog.tsx`, `DialogHost` in `App.tsx`).
- Show real API/provider error text to the user, not "Internal server error".
- Commit and push both repos after each piece of work (`git` prompts are pre-approved);
  revert with revert commits, never force-push.
- Settings → API Keys holds provider, model (dropdown), Anthropic **Workspace ID**
  (`wrkspc_…`, needed for the Files API with an org-wide key), quote engine, credit balance.

## In-app user guide

`frontend/src/pages/UserGuide.tsx`, route `/guide`, linked from the Dashboard hero and the
avatar menu. Update it whenever a menu or the Get Quote flow changes.

## Changelog (2026-10)

- **10-03** Claude knowledge engine (Files API training, generate/verify/chat), editable
  prompts table, live progress card, OCR training script, modern UI, app dialogs, model
  dropdowns, workspace id setting.
- **10-06 (morning)** Cost-reduction experiment (catalogue index + section pick, 1h cache,
  fast model, auto-train, rate-limit retries, unlimited upload) — **fully reverted the same
  day at the user's request** (code, DB migration and Claude section files). Current engine is
  the full-text one above.
- **10-06** Chat changes no longer blank model numbers (field-name normalisation, BOM sent in
  answer shape). In-app user guide re-created. **Rule groups**: `brand_rule_groups` table,
  group-first rules UI, grouped Get Quote picker, rename / name-the-ungrouped endpoints.
  Sanitized dump refreshed. `.gitignore`: `db/*.sql` except `db/jobwork_local.sql`, `*.zip`.
- **10-22** Training emails (`modules/email/training.emails.ts`): STARTED / COMPLETED / FAILED (and
  "completed with a warning" when only the pgvector index failed) to the user who clicked Train
  (fallback: the uploader; after a restart `failInterruptedClaudeTraining` mails the uploader). Letter-pad
  layout, logged in `email_logs`, best-effort (SMTP unset = console warning only). `renderTrainingEmail()`
  for previews. Rule training sends no email. Recipients/events: Settings → Notifications (`notification_settings` singleton, `GET/PUT /settings/notifications`, `POST .../test-training` sends a sample). Fixed address list + "also the user who clicked Train"; per-event switches; master switch.
- **10-22** Page search (PostgreSQL 16 + pgvector, local fastembed embeddings), off by default —
  see "Page search" above. Usage cost now cache-aware with Opus 5.5 / Sonnet 5.5 / Haiku 5.5 prices
  (Opus 5.5 was billed at Opus 5 rates before). Sonnet 5.5 / Haiku 5.5 in the model dropdown.
- Open ideas (not built): cost plan — chat without price lists, 1h caching, model tiering,
  parsed catalogue with candidate rows; local Ollama tier; LiteParse for PDF tables (tested,
  not adopted).

## Data currently trained (dev DB)

Brand **LK**: Price list 1 (48 pages) and Price list 2 (156 pages) trained as text; 8 rules,
all trained and in one group. Workspace `wrkspc_01XGSYvugFMcGeGDGbqwMGoP`.
