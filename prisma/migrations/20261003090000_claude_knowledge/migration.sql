-- Quote engine switch + per-file Claude knowledge (Files API) tracking.
ALTER TABLE `llm_settings`
    ADD COLUMN `quote_engine` VARCHAR(20) NOT NULL DEFAULT 'database';

ALTER TABLE `product_documents`
    ADD COLUMN `ai_file_id` VARCHAR(120) NULL,
    ADD COLUMN `ai_status` ENUM('NOT_STARTED', 'PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'NOT_STARTED',
    ADD COLUMN `ai_error` TEXT NULL,
    ADD COLUMN `ai_file_chars` INTEGER NULL,
    ADD COLUMN `ai_trained_at` DATETIME(3) NULL;
