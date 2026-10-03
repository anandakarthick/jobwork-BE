-- Brand files in Claude: keep the original PDF (when Anthropic's limits allow) plus its text.
ALTER TABLE `product_documents`
    ADD COLUMN `ai_file_kind` VARCHAR(10) NULL,
    ADD COLUMN `ai_pages` INTEGER NULL,
    ADD COLUMN `ai_text_file_id` VARCHAR(120) NULL;
