import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * SITE
   */
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
          'Whether this instance can render a page to PDF — i.e. whether the Puppeteer extension is installed (`WIKI.models.renderQueue.isAvailable()`). Instance-wide, not a per-site setting: lets the PDF export control hide or disable itself with an explanatory tooltip instead of offering a button that always fails.'
      },
      docsBase: {
        type: 'string',
        description:
          "Base URL this instance's in-app \"view docs\" / help links are built from (`WIKI.config.docsBase`, from `base.yml`). Instance-wide, not a per-site setting: `siteStore.docsBase` on the frontend appends a path to it, e.g. `docsBase + '/admin/general'`."
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
      pageExtensions: {
        type: 'array',
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
              // Deliberately loose: `editors.config` above is documented as free-form per editor
              // implementation; this is that same blob for one specific editor.
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
              // Deliberately loose: `editors.config` above is documented as free-form per editor
              // implementation; this is that same blob for one specific editor.
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
              // Deliberately loose: `editors.config` above is documented as free-form per editor
              // implementation; this is that same blob for one specific editor.
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
            enum: ['centered', 'full']
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
