-- AlterTable
ALTER TABLE `quote_messages` ADD COLUMN `attachments` JSON NULL;

-- AlterTable
ALTER TABLE `quotes` ADD COLUMN `download_name` VARCHAR(190) NULL;

