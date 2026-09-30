-- DropForeignKey
ALTER TABLE `email_logs` DROP FOREIGN KEY `email_logs_template_id_fkey`;

-- DropForeignKey
ALTER TABLE `email_templates` DROP FOREIGN KEY `email_templates_created_by_id_fkey`;

-- AlterTable
ALTER TABLE `email_logs` DROP COLUMN `template_id`;

-- DropTable
DROP TABLE `email_templates`;

