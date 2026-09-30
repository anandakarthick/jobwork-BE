-- AlterTable
ALTER TABLE `llm_settings` ADD COLUMN `anthropic_balance` DECIMAL(14, 2) NULL,
    ADD COLUMN `balance_currency` VARCHAR(8) NOT NULL DEFAULT 'USD',
    ADD COLUMN `openai_balance` DECIMAL(14, 2) NULL;

