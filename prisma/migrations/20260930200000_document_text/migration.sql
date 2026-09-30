-- AlterTable
ALTER TABLE `product_documents` ADD COLUMN `text_status` ENUM('NOT_STARTED', 'PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'NOT_STARTED',
    ADD COLUMN `text_error` TEXT NULL,
    ADD COLUMN `text_chars` INTEGER NULL;

-- CreateTable
CREATE TABLE `product_document_texts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `document_id` INTEGER NOT NULL,
    `seq` INTEGER NOT NULL,
    `text` MEDIUMTEXT NOT NULL,

    UNIQUE INDEX `product_document_texts_document_id_seq_key`(`document_id`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `product_document_texts` ADD CONSTRAINT `product_document_texts_document_id_fkey` FOREIGN KEY (`document_id`) REFERENCES `product_documents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
