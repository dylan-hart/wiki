import type { FastifyInstance } from 'fastify'
import { pathDisplayCaseStyles } from '../../models/sites.ts'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  app.addSchema({
    $id: 'Site',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid'
      },
      hostname: {
        type: 'string',
        format: 'hostname'
      },
      isEnabled: {
        type: 'boolean'
      },
      pdfExportAvailable: {
        type: 'boolean',
        description:
          'Whether this instance can render a page to PDF — i.e. whether the Puppeteer extension is installed (`CARDINAL.models.renderQueue.isAvailable()`). Instance-wide, not a per-site setting: lets the PDF export control hide or disable itself with an explanatory tooltip instead of offering a button that always fails.'
      },
      docsBase: {
        type: 'string',
        description:
          "Base URL this instance's in-app \"view docs\" / help links are built from (`CARDINAL.config.docsBase`, from `base.yml`). Instance-wide, not a per-site setting: `siteStore.docsBase` on the frontend appends a path to it, e.g. `docsBase + '/admin/general'`."
      },
      isReplicationEnabled: {
        type: 'boolean',
        description:
          'Whether this instance is configured as a scheduled-replication TARGET (`CARDINAL.config.replication.isEnabled`, from `base.yml`/`config.yml` — see Epic #2437). Instance-wide, not a per-site setting: a replication target periodically wipes and replaces its own data from a source instance, which is what this flag lets the frontend warn an admin about (header banner, Feature #2833).'
      },
      guestsMayViewProfiles: {
        type: 'boolean',
        description:
          "Whether an anonymous visitor may open a user profile (`CARDINAL.config.profileVisibility.guestsMayView`). Instance-wide, not a per-site setting. Carried here because `GET /users/profile-visibility` needs `read:users`, so a guest's browser has no other way to know whether to make avatars clickable."
      },
      navigationId: {
        type: 'string',
        format: 'uuid',
        description:
          "This site's default (locale-scoped) menu row id, resolved via `ensureSiteNav()` (`models/navigation.ts`). What `NavSidebar.vue`'s nav-loading watcher falls back to when there is no page-inherited `navigationId` -- a non-content `MainLayout` route (the knowledge graph, tags browse) never calls `pageLoad()`, so without this it never learns a real navigationId to load a menu for (OpenProject #2526/#2527)."
      },
      blocksConfig: {
        type: 'object',
        description:
          "This site's per-block config, keyed by block tag, for a block that is enabled AND declares at least one config field. Never includes a disabled block or one with nothing configurable — see `siteBlocksInfoFor` in api/sites.ts. Lets a reader's browser resolve a block's site-wide config (e.g. block-map's tile server URL) without the manage:sites-gated GET /sites/:siteId/blocks route.",
        additionalProperties: {
          type: 'object',
          additionalProperties: true
        }
      },
      commentsProvider: {
        type: 'object',
        nullable: true,
        description:
          "Null unless this site's active comment provider (`CARDINAL.models.commentProviders`) is a `codeTemplate` one (Disqus/Commento/Artalk) -- the native `default` provider, and a site with none active, both read as null. `PageCommentsEmbed.vue` reads this to decide whether to render a vendor embed at all, and off what config/origin, instead of `PageComments.vue`'s native list. `origin` is `requestOrigin(req.protocol, req.hostname)` (`helpers/common.ts`), computed from the request that served THIS payload, never a stored setting -- see `models/commentProviders.ts`'s canonical-URL boundary doc comment.",
        properties: {
          module: {
            type: 'string',
            description: 'Directory name under `modules/comments`.'
          },
          title: {
            type: 'string'
          },
          config: {
            type: 'object',
            additionalProperties: true,
            description:
              "The active provider's config values, completed with its declared defaults."
          },
          origin: {
            type: 'string',
            description:
              "This request's own `scheme://host[:port]` -- see the field description above."
          }
        }
      },
      blocksIndex: {
        type: 'object',
        description:
          "This site's enabled blocks, keyed by block tag, as `{ id, isCustom }`. Never includes a disabled block — see `siteBlocksInfoFor` in api/sites.ts. Lets a reader's browser resolve an undefined `block-*` element to a custom block's `/_blocks/custom/:siteId/:id.js` import URL without the manage:sites-gated GET /sites/:siteId/blocks route (OpenProject #954).",
        additionalProperties: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid'
            },
            isCustom: {
              type: 'boolean'
            }
          }
        }
      },
      title: {
        type: 'string'
      },
      description: {
        type: 'string'
      },
      company: {
        type: 'string'
      },
      contentLicense: {
        type: 'string'
      },
      footerExtra: {
        type: 'string'
      },
      banner: {
        type: 'object',
        description:
          'Admin-authored site-wide banner. `title` and `content` are plain text: never markdown-rendered or sanitized as HTML.',
        properties: {
          isEnabled: {
            type: 'boolean'
          },
          title: {
            type: 'string',
            maxLength: 255
          },
          content: {
            type: 'string',
            maxLength: 2000
          }
        }
      },
      pageExtensions: {
        type: 'array',
        items: {
          type: 'string'
        }
      },
      allowedUrlSchemes: {
        type: 'array',
        description:
          'Additional URL schemes permitted in page link/embed hrefs, additive to the hardcoded safe defaults.',
        items: {
          type: 'string'
        }
      },
      discoverable: {
        type: 'boolean'
      },
      defaults: {
        type: 'object',
        properties: {
          tocDepth: {
            type: 'object',
            properties: {
              min: {
                type: 'number'
              },
              max: {
                type: 'number'
              }
            }
          }
        }
      },
      features: {
        type: 'object',
        additionalProperties: false,
        properties: {
          browse: {
            type: 'boolean'
          },
          collaborativeEditing: {
            type: 'boolean'
          },
          comments: {
            type: 'boolean'
          },
          pageScripts: {
            type: 'boolean',
            description:
              'The site-wide execution kill switch for per-page scripts/styles (Feature #3389). Off by default. Distinct from write:scripts/write:styles, which gate authoring a script/style into page content in the first place -- this is the additional switch that decides whether an authored one is ever allowed to run/render at all.'
          },
          profile: {
            type: 'boolean'
          },
          reasonForChange: {
            type: 'string',
            enum: ['off', 'optional', 'required']
          },
          search: {
            type: 'boolean'
          },
          semanticSearch: {
            type: 'boolean',
            description:
              "Whether semantic (vector) search is available on this site right now -- the AND of the instance-wide boot-time capability (`CARDINAL.capabilities.semanticSearch`, Task #3095: whether pgvector was successfully provisioned) and this site's own `search.config.semanticEnabled` admin setting (Task #3104). Computed at request time in `buildSitePayload` (api/sites.ts); this is the single source of truth the semantic-search route (Task #3102) and the frontend mode toggle/admin setting visibility both read, rather than re-deriving it from the two inputs themselves."
          },
          showOtherGroups: {
            type: 'boolean',
            description:
              'Whether the profile Groups tab shows a section listing groups the viewer is NOT a member of, in addition to the ones it belongs to.'
          }
        }
      },
      uploads: {
        type: 'object',
        properties: {
          conflictBehavior: {
            type: 'string',
            description:
              'What an upload does about a file already at the name it wants: replace it in place, refuse the upload, or store the arrival as the next free `name-1.ext`.',
            enum: ['overwrite', 'reject', 'new']
          }
        }
      },
      logoText: {
        type: 'boolean'
      },
      sitemap: {
        type: 'boolean'
      },
      pathDisplayCase: {
        type: 'string',
        description:
          "The case style applied at render time to a path-derived label (breadcrumbs, sidebar/tree navigation, auto-nav, a page's own displayed name) — computed off the raw lowercase tree segment, not the stored `title` (Feature #2574). `off` shows the raw lowercase segment unchanged; the others humanize it (`text-case`-style camel/pascal/title casing, or forcing all-lower/all-upper), with a site's Glossary acronym entries overriding a word's casing regardless of the style picked. Written via `PUT /sites/:siteId/navigation/pathDisplay` (`site:navigation`), not this general site-update route.",
        enum: [...pathDisplayCaseStyles]
      },
      robots: {
        type: 'object',
        properties: {
          index: {
            type: 'boolean'
          },
          follow: {
            type: 'boolean'
          }
        }
      },
      security: {
        type: 'object',
        description:
          'Per-site security settings stored on the general surface (Feature #3267). Distinct from the instance-wide `security.disallowIframe`/`xFrameOptions` config, which this does not touch.',
        properties: {
          embedAllowedOrigins: {
            type: 'array',
            description:
              "Origins (`scheme://host[:port]`, lowercase, no path/query/fragment) permitted to embed this site's pages via iframe -- relaxes `frame-ancestors` CSP for exactly these origins (Task #3275 reads this array; enforcement lives there, not here). Empty (the default) means no embedding is allowed, i.e. today's unchanged behavior.",
            items: {
              type: 'string',
              maxLength: 255,
              pattern:
                '^https?:\\/\\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:[0-9]{1,5})?$'
            }
          }
        }
      },
      auth: {
        type: 'object',
        description: 'Login experience for this site. Redirects can be overridden per group.',
        properties: {
          autoLogin: {
            type: 'boolean'
          },
          bypassUnauthorized: {
            type: 'boolean'
          },
          hideLocal: {
            type: 'boolean'
          },
          loginRedirect: {
            type: 'string',
            maxLength: 255
          },
          welcomeRedirect: {
            type: 'string',
            maxLength: 255
          },
          logoutRedirect: {
            type: 'string',
            maxLength: 255
          }
        }
      },
      authStrategies: {
        type: 'array',
        description: 'Which authentication strategies this site offers, in display order.',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid'
            },
            order: {
              type: 'integer',
              minimum: 0
            },
            isVisible: {
              type: 'boolean'
            }
          }
        }
      },
      locales: {
        type: 'object',
        properties: {
          primary: {
            type: 'string'
          },
          active: {
            type: 'array',
            items: {
              type: 'string'
            }
          },
          forcePrefix: {
            type: 'boolean'
          },
          aliases: {
            type: 'object',
            description:
              'URL segment each active locale is served under instead of its code, keyed by the canonical code (`{ "zh-CN": "zh" }`). Pages, tree entries and page rules keep the canonical code.',
            additionalProperties: {
              type: 'string',
              maxLength: 64
            }
          },
          showMenu: {
            type: 'boolean',
            description:
              'Whether the sidebar offers a locale selector to switch between the active locales.'
          }
        }
      },
      assets: {
        type: 'object',
        description:
          'Which images have been uploaded for this site. The images themselves are served from `/_site/<siteId>/<logo|favicon|loginBg>`, which falls back to the built-in default wherever the flag is false.',
        properties: {
          logo: {
            type: 'boolean'
          },
          favicon: {
            type: 'boolean'
          },
          loginBg: {
            type: 'boolean'
          }
        }
      },
      editors: {
        type: 'object',
        description:
          'Per-editor state. `config` is free-form and specific to each editor implementation.',
        properties: {
          asciidoc: {
            type: 'object',
            properties: {
              isActive: {
                type: 'boolean'
              },
              config: {
                type: 'object',
                additionalProperties: true
              }
            }
          },
          code: {
            type: 'object',
            properties: {
              isActive: {
                type: 'boolean'
              },
              config: {
                type: 'object',
                additionalProperties: true
              }
            }
          },
          markdown: {
            type: 'object',
            properties: {
              isActive: {
                type: 'boolean'
              },
              config: {
                type: 'object',
                additionalProperties: true
              }
            }
          },
          wysiwyg: {
            type: 'object',
            properties: {
              isActive: {
                type: 'boolean'
              },
              config: {
                type: 'object',
                additionalProperties: true
              }
            }
          }
        }
      },
      theme: {
        type: 'object',
        properties: {
          dark: {
            type: 'boolean'
          },
          aesthetic: {
            type: 'string',
            enum: ['ledger', 'cobalt']
          },
          codeBlocksTheme: {
            type: 'string',
            description: 'Name of a highlight.js stylesheet, e.g. `github-dark`.',
            maxLength: 255
          },
          colorPrimary: {
            type: 'string',
            format: 'hexcolor'
          },
          colorSecondary: {
            type: 'string',
            format: 'hexcolor'
          },
          colorAccent: {
            type: 'string',
            format: 'hexcolor'
          },
          colorHeader: {
            type: 'string',
            format: 'hexcolor'
          },
          colorSidebar: {
            type: 'string',
            format: 'hexcolor'
          },
          injectCSS: {
            type: 'string'
          },
          injectHead: {
            type: 'string'
          },
          injectBody: {
            type: 'string'
          },
          contentWidth: {
            type: 'string',
            enum: ['measured', 'full']
          },
          sidebarPosition: {
            type: 'string',
            enum: ['off', 'left', 'right']
          },
          tocPosition: {
            type: 'string',
            enum: ['off', 'left', 'right']
          },
          showPrintBtn: {
            type: 'boolean'
          },
          baseFont: {
            type: 'string'
          },
          contentFont: {
            type: 'string'
          }
        }
      },
      analytics: {
        type: 'object',
        description:
          'Which analytics providers this site has configured. Provider definitions themselves — what props each one takes — come from `GET /_api/analytics/modules`, discovered from `modules/analytics` the same way authentication modules are.',
        properties: {
          providers: {
            type: 'object',
            description: 'Keyed by provider key, e.g. `google`, `gtm`, `matomo`.',
            additionalProperties: {
              type: 'object',
              properties: {
                isEnabled: {
                  type: 'boolean'
                },
                config: {
                  type: 'object',
                  additionalProperties: true
                }
              }
            }
          }
        }
      }
    }
  })
}
