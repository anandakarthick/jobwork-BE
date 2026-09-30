-- AlterTable
ALTER TABLE `product_documents` ADD COLUMN `brand` VARCHAR(80) NULL,
    ADD COLUMN `ingest_error` TEXT NULL,
    ADD COLUMN `ingest_status` ENUM('NOT_STARTED', 'PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'NOT_STARTED',
    ADD COLUMN `ingested_at` DATETIME(3) NULL,
    ADD COLUMN `ingested_item_count` INTEGER NULL,
    ADD COLUMN `kind` ENUM('PRICE_LIST', 'SPEC', 'DRAWING', 'OTHER') NOT NULL DEFAULT 'OTHER';

-- CreateTable
CREATE TABLE `price_list_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `document_id` INTEGER NOT NULL,
    `category_id` INTEGER NOT NULL,
    `brand` VARCHAR(80) NOT NULL,
    `family` VARCHAR(160) NULL,
    `type` VARCHAR(160) NULL,
    `catalog_no` VARCHAR(160) NOT NULL,
    `description` TEXT NOT NULL,
    `poles` INTEGER NULL,
    `rating_amp` DECIMAL(10, 2) NULL,
    `rating_amp_min` DECIMAL(10, 2) NULL,
    `rating_amp_max` DECIMAL(10, 2) NULL,
    `breaking_ka` DECIMAL(10, 2) NULL,
    `list_price` DECIMAL(12, 2) NOT NULL,
    `unit` VARCHAR(40) NULL,
    `page_no` INTEGER NULL,
    `raw_text` TEXT NULL,
    `attributes` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `price_list_items_document_id_idx`(`document_id`),
    INDEX `price_list_items_category_id_brand_idx`(`category_id`, `brand`),
    INDEX `price_list_items_catalog_no_idx`(`catalog_no`),
    INDEX `price_list_items_brand_rating_amp_idx`(`brand`, `rating_amp`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `product_documents_kind_idx` ON `product_documents`(`kind`);

-- AddForeignKey
ALTER TABLE `price_list_items` ADD CONSTRAINT `price_list_items_document_id_fkey` FOREIGN KEY (`document_id`) REFERENCES `product_documents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `price_list_items` ADD CONSTRAINT `price_list_items_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `product_categories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

