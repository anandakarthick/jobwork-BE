-- AlterTable
ALTER TABLE `customers` ADD COLUMN `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE';

-- CreateIndex
CREATE INDEX `customers_status_idx` ON `customers`(`status`);
