# Database dump

`jobwork_local.sql` is a MySQL/MariaDB dump of the development database: schema plus data
(brands, keyword prompts, reference files and their text, trained price-list rows, customers,
quotes and chats).

It deliberately leaves out the tables that hold secrets — `users`, `password_resets`,
`llm_settings` (API keys) and `smtp_settings` — so it is safe to keep in the repository.

To use it:

```bash
mysql -u root -e "CREATE DATABASE jobwork_local CHARACTER SET utf8mb4"
mysql -u root jobwork_local < db/jobwork_local.sql
npx prisma migrate deploy      # creates the four omitted tables
npm run seed                   # admin@jobwork.local / admin123
```

Then add the AI provider key under **Settings → API Keys** and SMTP under **Settings → Email**.
Uploaded files (`uploads/`) are not in git; re-upload the price lists on the Brands page.
