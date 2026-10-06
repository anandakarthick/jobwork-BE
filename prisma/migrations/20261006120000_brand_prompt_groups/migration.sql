-- Brand rules can be grouped (e.g. "MCCB"); Get Quote ticks/unticks a whole group.
ALTER TABLE `brand_prompts`
    ADD COLUMN `group_name` VARCHAR(100) NOT NULL DEFAULT '';
