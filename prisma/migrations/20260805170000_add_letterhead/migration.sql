-- CreateTable
CREATE TABLE `letterheads` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `html` LONGTEXT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

