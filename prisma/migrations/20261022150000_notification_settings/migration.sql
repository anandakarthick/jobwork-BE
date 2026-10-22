-- Settings → Notifications: recipients of the training emails (singleton, id = 1)
CREATE TABLE `notification_settings` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `training_enabled` BOOLEAN NOT NULL DEFAULT true,
    `training_recipients` TEXT NULL,
    `training_notify_starter` BOOLEAN NOT NULL DEFAULT true,
    `training_on_started` BOOLEAN NOT NULL DEFAULT true,
    `training_on_completed` BOOLEAN NOT NULL DEFAULT true,
    `training_on_failed` BOOLEAN NOT NULL DEFAULT true,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
