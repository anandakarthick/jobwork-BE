-- CreateTable
CREATE TABLE `smtp_settings` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `host` VARCHAR(190) NULL,
    `port` INTEGER NOT NULL DEFAULT 587,
    `secure` BOOLEAN NOT NULL DEFAULT false,
    `username` VARCHAR(190) NULL,
    `password` TEXT NULL,
    `from_name` VARCHAR(120) NULL,
    `from_email` VARCHAR(190) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

