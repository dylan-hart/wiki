import type { FastifyInstance } from 'fastify'
import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'

import {
  OPENAPI_SECURITY,
  OPENAPI_SECURITY_SCHEMES,
  swaggerTransform
} from '../../helpers/openapi.ts'

export function registerOpenApi(app: FastifyInstance): void {
  app.register(fastifySwagger, {
    hideUntagged: true,
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Cardinal.js API',
        version: CARDINAL.version
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
      Neither sorter is on by default — the order is otherwise the order the routes were registered
      in, which is arbitrary to anyone reading the docs. `operationsSorter: 'alpha'` sorts on the
      path, not the summary, so the several methods of one path stay together.
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
            A stylesheet rather than the plugin's `logo` option, which base64-inlines a buffer at
            boot. This documentation is served for whichever site the request arrived at, and an
            administrator can change that site's logo at any time — a URL resolves both per request.

            `contain` in a box wider than it is tall, so a square mark and a wordmark both fit
            undistorted.
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
