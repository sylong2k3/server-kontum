-- Forest classification v5.3 expands the class schema from 0-10 to 0-12:
-- 0 = no-data, 1-11 = land-cover classes, 12 = unknown.

ALTER TABLE forest.forest_gt_zones
    DROP CONSTRAINT IF EXISTS forest_gt_zones_class_id_check;
UPDATE forest.forest_gt_zones SET class_id = class_id + 1;
ALTER TABLE forest.forest_gt_zones
    ADD CONSTRAINT forest_gt_zones_class_id_check
    CHECK (class_id BETWEEN 0 AND 12);

ALTER TABLE forest.forest_gt_points
    DROP CONSTRAINT IF EXISTS forest_gt_points_class_id_check;
UPDATE forest.forest_gt_points SET class_id = class_id + 1;
ALTER TABLE forest.forest_gt_points
    ADD CONSTRAINT forest_gt_points_class_id_check
    CHECK (class_id BETWEEN 0 AND 12);
