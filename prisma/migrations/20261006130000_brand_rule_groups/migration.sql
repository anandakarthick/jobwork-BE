-- Rule groups: a brand's rules are created inside named groups (e.g. "MCCB") and
-- Get Quote can tick a whole group at once. Replaces the free-text group_name.
CREATE TABLE `brand_rule_groups` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `brand_rule_groups_company_id_name_key`(`company_id`, `name`),
    INDEX `brand_rule_groups_company_id_sort_order_idx`(`company_id`, `sort_order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `brand_rule_groups`
    ADD CONSTRAINT `brand_rule_groups_company_id_fkey`
    FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `brand_prompts`
    DROP COLUMN `group_name`,
    ADD COLUMN `group_id` INTEGER NULL;

CREATE INDEX `brand_prompts_group_id_idx` ON `brand_prompts`(`group_id`);

ALTER TABLE `brand_prompts`
    ADD CONSTRAINT `brand_prompts_group_id_fkey`
    FOREIGN KEY (`group_id`) REFERENCES `brand_rule_groups`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
