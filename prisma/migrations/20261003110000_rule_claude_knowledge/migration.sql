-- Brand rules trained into Claude (Files API) — id + status per rule.
ALTER TABLE `brand_prompts`
    ADD COLUMN `ai_file_id` VARCHAR(120) NULL,
    ADD COLUMN `ai_status` ENUM('NOT_STARTED', 'PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'NOT_STARTED',
    ADD COLUMN `ai_error` TEXT NULL,
    ADD COLUMN `ai_trained_at` DATETIME(3) NULL;
