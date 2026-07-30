// Audit and turns routes: the audit-log read and the conversation-turns read.
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import { createRequestId } from '../../domain/ids.js';
import { createProblem } from '../problem.js';
import { auditListQuerySchema, turnsQuerySchema } from '../schemas.js';

import type { RouteDefinition } from '../routeSupport.js';

export const auditRoutes: readonly RouteDefinition[] = [
  {
    method: 'GET',
    pattern: /^\/v1\/audit$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const query = auditListQuerySchema.parse({
        limit: url.searchParams.get('limit') ?? undefined,
        since: url.searchParams.get('since') ?? undefined,
      });
      return [200, { data: await context.vaultWriter.readAuditEvents(query) }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/turns$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const threadUrl = url.searchParams.get('threadUrl');
      if (threadUrl === null) {
        return [
          400,
          createProblem({
            title: 'threadUrl query parameter is required',
            status: 400,
            code: 'MISSING_PARAMETER',
            correlationId: createRequestId(),
            detail: 'GET /v1/turns requires a threadUrl query parameter.',
          }),
        ];
      }
      const query = turnsQuerySchema.parse({
        threadUrl,
        limit: url.searchParams.get('limit') ?? undefined,
        role: url.searchParams.get('role') ?? undefined,
      });
      return [200, { data: await context.vaultWriter.readRecentTurns(query) }];
    },
  },
];
