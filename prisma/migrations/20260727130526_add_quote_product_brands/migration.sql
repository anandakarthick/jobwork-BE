-- AlterTable
ALTER TABLE `jobwork_analyses` ADD COLUMN `brands` JSON NULL,
    ADD COLUMN `category_id` INTEGER NULL;

-- CreateIndex
CREATE INDEX `jobwork_analyses_category_id_idx` ON `jobwork_analyses`(`category_id`);

-- AddForeignKey
ALTER TABLE `jobwork_analyses` ADD CONSTRAINT `jobwork_analyses_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `product_categories`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
