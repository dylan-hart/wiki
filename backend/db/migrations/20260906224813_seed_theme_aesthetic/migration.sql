-- Give every existing site an explicit `theme.aesthetic`.
--
-- The Cobalt aesthetic (Feature #2753) adds `theme.aesthetic: 'ledger' | 'cobalt'` alongside `dark`,
-- seeded on new sites from here on. An instance that already existed has no such key in its
-- `sites.config` jsonb, and code reads it as `site.theme.aesthetic ?? 'ledger'` -- but the Ledger
-- rollout (see the two migrations above) showed that a code-level fallback alone leaves an existing
-- row silently dependent on it forever, so this writes the value explicitly instead, once.
--
-- Guarded on the key being absent, not on any particular value, so re-running this after a site has
-- already been migrated (or already saved a real choice) is a no-op either way.
UPDATE "sites" SET config = jsonb_set(config, '{theme,aesthetic}', '"ledger"')
  WHERE config #>> '{theme,aesthetic}' IS NULL;
