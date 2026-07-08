-- Restrict Sở TN&MT news/comment permissions.
-- Sở TN&MT may read news and create/publish specialized news, but must not
-- administratively edit/delete general news or moderate comments.
UPDATE auth.roles
SET permissions = jsonb_set(
    jsonb_set(
        permissions,
        '{news}',
        '{"read": true, "create": true, "publish": true}'::jsonb,
        true
    ),
    '{news_translations}',
    '{"read": true, "create": true}'::jsonb,
    true
)
WHERE code = 'so_nnmt';

UPDATE auth.roles
SET permissions = jsonb_set(
    permissions,
    '{comments}',
    '{"read": true}'::jsonb,
    true
)
WHERE code = 'so_nnmt';
