// Reminder routes: create and patch.
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import { reminderCreateSchema, reminderUpdateSchema } from '../schemas.js';

import { mutationResponse, readBody } from '../routeSupport.js';
import type { RouteDefinition } from '../routeSupport.js';

export const remindersRoutes: readonly RouteDefinition[] = [
  {
    method: 'POST',
    pattern: /^\/v1\/reminders$/,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      const input = reminderCreateSchema.parse(await readBody(request));
      const result = await context.vaultWriter.createReminder(input, requestId);
      return [201, mutationResponse(result, requestId)];
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/v1\/reminders\/(?<reminderId>[A-Za-z0-9_-]+)$/,
    authRequired: true,
    handle: async (request, requestId, match, context) => {
      if (match.reminderId === undefined) {
        throw new Error('Missing reminderId path parameter.');
      }
      const input = reminderUpdateSchema.parse(await readBody(request));
      const result = await context.vaultWriter.updateReminder(match.reminderId, input, requestId);
      return [200, mutationResponse(result, requestId)];
    },
  },
];
