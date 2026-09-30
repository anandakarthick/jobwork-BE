-- CreateTable
CREATE TABLE `llm_settings` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `provider` VARCHAR(20) NOT NULL DEFAULT 'stub',
    `openai_api_key` TEXT NULL,
    `openai_model` VARCHAR(80) NOT NULL DEFAULT 'gpt-4o',
    `anthropic_api_key` TEXT NULL,
    `anthropic_model` VARCHAR(80) NOT NULL DEFAULT 'claude-opus-4-8',
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

