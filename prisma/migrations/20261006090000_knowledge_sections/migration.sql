-- Catalogue index sections (Claude files), fast model setting, per-quote section pick.
CREATE TABLE `knowledge_sections` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `document_id` INTEGER NOT NULL,
    `name` VARCHAR(190) NOT NULL,
    `keywords` TEXT NOT NULL,
    `ai_file_id` VARCHAR(120) NOT NULL,
    `chars` INTEGER NOT NULL,
    `line_count` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `knowledge_sections_document_id_idx`(`document_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `knowledge_sections`
    ADD CONSTRAINT `knowledge_sections_document_id_fkey`
    FOREIGN KEY (`document_id`) REFERENCES `product_documents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `product_documents`
    ADD COLUMN `ai_indexed_at` DATETIME(3) NULL,
    ADD COLUMN `ai_section_count` INTEGER NULL;

ALTER TABLE `llm_settings`
    ADD COLUMN `anthropic_fast_model` VARCHAR(80) NOT NULL DEFAULT 'claude-haiku-4-5-20251001';

ALTER TABLE `quotes`
    ADD COLUMN `knowledge_section_ids` JSON NULL;
