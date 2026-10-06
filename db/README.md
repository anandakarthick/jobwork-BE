# Database dump

`jobwork_local.sql` is a MySQL/MariaDB dump of the development database: schema plus data
(brands, rules, reference-file records and their catalogue-index sections, parsed price-list
rows, system prompts, customers, quotes and chats).

It deliberately leaves out the tables that hold secrets or per-installation data — `users`,
`password_resets`, `llm_settings` (API keys, workspace id), `smtp_settings`, `llm_usage` and
`email_logs` — so it is safe to keep in the repository.

To use it:

```bash
mysql -u root -e "CREATE DATABASE jobwork_local CHARACTER SET utf8mb4"
mysql -u root jobwork_local < db/jobwork_local.sql
npx prisma migrate deploy      # creates the omitted tables (migration history is in the dump)
npm run seed                   # admin@jobwork.local / admin123
```

Then add the AI provider key, Workspace ID and quote engine under **Settings → API Keys**, and
SMTP under **Settings → Email**.

Uploaded files (`uploads/`) are not in git: re-upload the price lists on the Brands page and
click **Train** on them. The Claude file ids in the dump (`ai_file_id`, `knowledge_sections`)
belong to the original Anthropic workspace — on a different account they are invalid until the
files and rules are trained again, which replaces them.
