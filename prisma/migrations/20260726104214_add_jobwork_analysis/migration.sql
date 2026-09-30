-- CreateTable
CREATE TABLE `jobwork_analyses` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `title` VARCHAR(190) NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `summary` TEXT NULL,
    `provider` VARCHAR(40) NULL,
    `error` TEXT NULL,
    `customer_id` INTEGER NOT NULL,
    `created_by_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `jobwork_analyses_customer_id_idx`(`customer_id`),
    INDEX `jobwork_analyses_created_by_id_idx`(`created_by_id`),
    INDEX `jobwork_analyses_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `jobwork_documents` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `analysis_id` INTEGER NOT NULL,
    `file_name` VARCHAR(255) NOT NULL,
    `stored_name` VARCHAR(255) NOT NULL,
    `mime_type` VARCHAR(120) NOT NULL,
    `size_bytes` INTEGER NOT NULL,
    `storage_path` VARCHAR(500) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `jobwork_documents_analysis_id_idx`(`analysis_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `jobwork_messages` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `analysis_id` INTEGER NOT NULL,
    `role` ENUM('SYSTEM', 'USER', 'ASSISTANT') NOT NULL,
    `content` TEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `jobwork_messages_analysis_id_idx`(`analysis_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `jobwork_requirements` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `analysis_id` INTEGER NOT NULL,
    `part_name` VARCHAR(255) NOT NULL,
    `quantity` INTEGER NULL,
    `specifications` TEXT NULL,
    `matched_category_id` INTEGER NULL,
    `suggested_brands` JSON NOT NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `jobwork_requirements_analysis_id_idx`(`analysis_id`),
    INDEX `jobwork_requirements_matched_category_id_idx`(`matched_category_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `jobwork_analyses` ADD CONSTRAINT `jobwork_analyses_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `jobwork_analyses` ADD CONSTRAINT `jobwork_analyses_created_by_id_fkey` FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `jobwork_documents` ADD CONSTRAINT `jobwork_documents_analysis_id_fkey` FOREIGN KEY (`analysis_id`) REFERENCES `jobwork_analyses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `jobwork_messages` ADD CONSTRAINT `jobwork_messages_analysis_id_fkey` FOREIGN KEY (`analysis_id`) REFERENCES `jobwork_analyses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `jobwork_requirements` ADD CONSTRAINT `jobwork_requirements_analysis_id_fkey` FOREIGN KEY (`analysis_id`) REFERENCES `jobwork_analyses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `jobwork_requirements` ADD CONSTRAINT `jobwork_requirements_matched_category_id_fkey` FOREIGN KEY (`matched_category_id`) REFERENCES `product_categories`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
