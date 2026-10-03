-- Anthropic workspace id for the Files API (default/org keys must name a workspace).
ALTER TABLE `llm_settings`
    ADD COLUMN `anthropic_workspace_id` VARCHAR(80) NULL;
