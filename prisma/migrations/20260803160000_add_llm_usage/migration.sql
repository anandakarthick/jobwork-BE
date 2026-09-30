-- AlterTable
ALTER TABLE `llm_settings` ADD COLUMN `anthropic_balance_at` DATETIME(3) NULL,
    ADD COLUMN `openai_balance_at` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `llm_usage` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `provider` VARCHAR(40) NOT NULL,
    `model` VARCHAR(80) NOT NULL,
    `feature` VARCHAR(60) NULL,
    `input_tokens` INTEGER NOT NULL DEFAULT 0,
    `output_tokens` INTEGER NOT NULL DEFAULT 0,
    `cost_usd` DECIMAL(12, 6) NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `llm_usage_provider_created_at_idx`(`provider`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

