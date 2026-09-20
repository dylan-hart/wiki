# Comment recommendations: OpenProject #3657 (backend/controllers/seo.ts)

- `buildRobotsTxt`'s doc comment is now wrong (it says both flags gate `Disallow: /`). Replace it with: `// robots.txt keys on index only; "index but don't follow" has no robots.txt form and is carried by the shell's X-Robots-Tag header and robots meta (helpers/shellRobots.ts).`
- `helpers/shellRobots.ts#robotsDirective`: add `// A site with no robots block yields undefined, so the shell carries no robots header or meta and crawlers apply their own default.`
