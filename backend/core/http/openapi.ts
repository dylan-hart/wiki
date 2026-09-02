import type { FastifyInstance } from 'fastify'
import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'

import {
  OPENAPI_SECURITY,
  OPENAPI_SECURITY_SCHEMES,
  swaggerTransform
} from '../../helpers/openapi.ts'

/**
 * The OpenAPI document and the Swagger UI that browses it at `/_api`.
 *
 * The `transform` that folds each route's declared permissions into its description lives in
 * `helpers/openapi.ts` beside the security-scheme constants — it is a pure function of the schema
 * and the route, and is unit-tested there.
 */
export function registerOpenApi(app: FastifyInstance): void {
  app.register(fastifySwagger, {
    hideUntagged: true,
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Wiki.js API',
        version: WIKI.version
      },
      components: {
        securitySchemes: OPENAPI_SECURITY_SCHEMES
      },
      security: OPENAPI_SECURITY
    },
    transform: swaggerTransform
  })
  app.register(fastifySwaggerUi, {
    routePrefix: '/_api',
    /*
      Swagger UI's own sorters, applied in the browser: tags down the page, and the operations inside
      each tag by path. Neither is on by default — the order is otherwise the order the routes were
      registered in, which is meaningful to `api/index.ts` and arbitrary to anyone reading the docs.

      `operationsSorter: 'alpha'` sorts on the path, not the summary, so the several methods of one
      path stay together and keep their registration order relative to each other.
    */
    uiConfig: {
      tagsSorter: 'alpha',
      operationsSorter: 'alpha'
    },
    // -> Left empty so the plugin inlines neither its own logo nor one of ours; the stylesheet below
    //    is what puts the site's logo in the topbar
    logo: {} as any,
    theme: {
      css: [
        {
          filename: 'wiki.css',
          /*
            The site's own logo in the topbar, as a background on the link swagger draws its wordmark
            in.

            A stylesheet rather than the plugin's `logo` option, which takes a buffer and base64-inlines
            it into the page when the server boots. This documentation is served for whichever site the
            request arrived at, and an administrator can change that site's logo at any time — a URL
            resolves both of those per request, and a buffer chosen at boot resolves neither.

            `contain` in a box wider than it is tall, so a square mark and a wordmark both sit sensibly
            without the logo being distorted to fit.
          */
          content: `
            .swagger-ui .topbar-wrapper a.link > * {
              display: none;
            }
            .swagger-ui .topbar-wrapper a.link {
              display: block;
              width: 160px;
              height: 40px;
              background: url('/_site/current/logo') left center / contain no-repeat;
            }
          `
        }
      ]
    }
  })
}
