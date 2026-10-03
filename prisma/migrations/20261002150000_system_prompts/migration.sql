-- CreateTable
CREATE TABLE `system_prompts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `key` VARCHAR(80) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `description` TEXT NOT NULL,
    `content` LONGTEXT NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `system_prompts_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
