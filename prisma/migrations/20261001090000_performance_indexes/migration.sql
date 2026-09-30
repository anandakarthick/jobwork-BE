-- Indexes for the app's hot queries. Composite indexes replace the single-column
-- ones they begin with (a foreign key is still served by the leftmost column).

-- Chat list: newest quotes first.
CREATE INDEX `quotes_created_at_idx` ON `quotes`(`created_at`);

-- A chat's messages in time order.
CREATE INDEX `quote_messages_quote_id_created_at_idx` ON `quote_messages`(`quote_id`, `created_at`);
DROP INDEX `quote_messages_quote_id_idx` ON `quote_messages`;

-- A quote's lines in line order.
CREATE INDEX `quote_lines_quote_id_line_no_idx` ON `quote_lines`(`quote_id`, `line_no`);
DROP INDEX `quote_lines_quote_id_idx` ON `quote_lines`;

-- A brand's trained keyword prompts.
CREATE INDEX `brand_prompts_company_id_train_idx` ON `brand_prompts`(`company_id`, `train`);
DROP INDEX `brand_prompts_company_id_idx` ON `brand_prompts`;

-- Quote generation: the trained, completed price lists of a brand.
CREATE INDEX `product_documents_brand_kind_ingest_status_idx` ON `product_documents`(`brand`, `kind`, `ingest_status`);
-- Chat reference lookup: a brand's files that have stored text.
CREATE INDEX `product_documents_company_id_text_status_idx` ON `product_documents`(`company_id`, `text_status`);
