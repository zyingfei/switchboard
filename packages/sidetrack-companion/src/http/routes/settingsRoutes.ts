// Settings routes: read, export, import, and patch.
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import { exportSettings } from '../../portability/exportBundle.js';
import { importSettings } from '../../portability/importBundle.js';
import { settingsPatchSchema } from '../schemas.js';

import { readBody, requireVaultRoot } from '../routeSupport.js';
import type { RouteDefinition } from '../routeSupport.js';

export const settingsRoutes: readonly RouteDefinition[] = [
  {
    method: 'GET',
    pattern: /^\/v1\/settings$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => [
      200,
      { data: await context.vaultWriter.readSettings() },
    ],
  },
  {
    method: 'GET',
    pattern: /^\/v1\/settings\/export$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => [
      200,
      await exportSettings(requireVaultRoot(context)),
    ],
  },
  {
    method: 'POST',
    pattern: /^\/v1\/settings\/import$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => [
      200,
      { data: await importSettings(requireVaultRoot(context), await readBody(request)) },
    ],
  },
  {
    method: 'PATCH',
    pattern: /^\/v1\/settings$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const input = settingsPatchSchema.parse(await readBody(request));
      return [200, { data: await context.vaultWriter.updateSettings(input, input.revision) }];
    },
  },
];
