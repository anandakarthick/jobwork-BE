-- CreateTable
CREATE TABLE `_CategoryCompanies` (
    `A` INTEGER NOT NULL,
    `B` INTEGER NOT NULL,

    UNIQUE INDEX `_CategoryCompanies_AB_unique`(`A`, `B`),
    INDEX `_CategoryCompanies_B_index`(`B`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `_CategoryCompanies` ADD CONSTRAINT `_CategoryCompanies_A_fkey` FOREIGN KEY (`A`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `_CategoryCompanies` ADD CONSTRAINT `_CategoryCompanies_B_fkey` FOREIGN KEY (`B`) REFERENCES `product_categories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
