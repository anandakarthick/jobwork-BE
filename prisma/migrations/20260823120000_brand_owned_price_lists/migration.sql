-- AlterTable: price lists are brand-owned, so category becomes optional
ALTER TABLE `price_list_items` MODIFY `category_id` INTEGER NULL;

-- AlterTable: product documents can belong to a brand (company) instead of a category
ALTER TABLE `product_documents` ADD COLUMN `company_id` INTEGER NULL,
    MODIFY `category_id` INTEGER NULL;

-- CreateIndex
CREATE INDEX `product_documents_company_id_idx` ON `product_documents`(`company_id`);

-- AddForeignKey
ALTER TABLE `product_documents` ADD CONSTRAINT `product_documents_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
