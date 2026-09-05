-- Move every existing site's theme onto Cardinal.
--
-- The re-skin changed `DEFAULT_THEME_COLORS` and the seeded fonts, but those only reach a site at
-- CREATION. An instance that already existed kept the 3.x values in its `sites.config` jsonb, so it
-- went on drawing a black header, a blue sidebar and blue links against an interface built for none
-- of them -- the design language applying or not depending on how old the row was.
--
-- Cardinal's chrome is the language, not a per-site preference, so this is a one-time correction
-- rather than a fallback: the columns stay editable afterwards and a site is free to theme away
-- from these again.
--
-- Written against the OLD values specifically, not applied unconditionally: a site that had already
-- been themed to something of its own keeps it. `#1976D2` / `#000000` / `#E81221` / `#018569` are
-- what `DEFAULT_THEME_COLORS` seeded before this branch, case-insensitively (the seed wrote upper
-- case, `AdminTheme.vue`'s picker writes lower).
UPDATE "sites" SET config = jsonb_set(config, '{theme,colorPrimary}', '"#c14a52"')
  WHERE lower(config #>> '{theme,colorPrimary}') = '#1976d2';--> statement-breakpoint
UPDATE "sites" SET config = jsonb_set(config, '{theme,colorSecondary}', '"#3f7a66"')
  WHERE lower(config #>> '{theme,colorSecondary}') = '#018569';--> statement-breakpoint
UPDATE "sites" SET config = jsonb_set(config, '{theme,colorAccent}', '"#c14a52"')
  WHERE lower(config #>> '{theme,colorAccent}') = '#e81221';--> statement-breakpoint
UPDATE "sites" SET config = jsonb_set(config, '{theme,colorHeader}', '"#ffffff"')
  WHERE lower(config #>> '{theme,colorHeader}') IN ('#000000', '#000');--> statement-breakpoint
UPDATE "sites" SET config = jsonb_set(config, '{theme,colorSidebar}', '"#f0f2f7"')
  WHERE lower(config #>> '{theme,colorSidebar}') = '#1976d2';--> statement-breakpoint
UPDATE "sites" SET config = jsonb_set(config, '{theme,baseFont}', '"barlow"')
  WHERE config #>> '{theme,baseFont}' = 'roboto';--> statement-breakpoint
UPDATE "sites" SET config = jsonb_set(config, '{theme,contentFont}', '"barlow"')
  WHERE config #>> '{theme,contentFont}' = 'roboto';
