-- Claude engine: send only the matching price-list pages (pgvector search)
ALTER TABLE `llm_settings` ADD COLUMN `page_search` BOOLEAN NOT NULL DEFAULT false;
