-- AlterTable
ALTER TABLE `brand_prompts` ADD COLUMN `name` VARCHAR(150) NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE `product_documents` ADD COLUMN `name` VARCHAR(150) NULL;
