// Model-fetch routes: the POST that starts a model download job and the GET
// that polls its status — thin wrappers around modelFetchRoute.ts.
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import { MODEL_FETCH_PATTERN, handleModelFetchStart, handleModelFetchStatus, type ModelFetchOutcome } from '../modelFetchRoute.js';

import { HttpRouteError, readBody } from '../routeSupport.js';
import type { RouteDefinition } from '../routeSupport.js';

// Translate a model-fetch outcome into the route contract: the job status
// under the standard `{ data }` envelope, or the typed HTTP error the module
// decided on (403 when the kill switch is off, 400 for a rejected path/body).
const modelFetchResult = (outcome: ModelFetchOutcome): readonly [number, unknown] => {
  if (outcome.ok) return [200, { data: outcome.status }];
  throw new HttpRouteError(
    outcome.httpStatus,
    outcome.code,
    outcome.code === 'MODEL_FETCH_DISABLED' ? 'Model fetching is disabled.' : 'Validation failed.',
    outcome.detail,
  );
};

export const modelRoutes: readonly RouteDefinition[] = [
  {
    // MODEL FETCH — POST /v1/models/{org}/{repo}/fetch.
    //
    // THE ONLY COMPANION ROUTE THAT REACHES THE PUBLIC INTERNET FOR MODELS. It
    // downloads a caller-declared file list from huggingface.co into the model
    // cache so the (unauthenticated, loopback) GET model host can serve it
    // offline forever. See modelFetchRoute.ts for the full outbound posture,
    // the .part+rename durability rule, and the SIDETRACK_MODEL_FETCH switch.
    //
    // AUTHENTICATED — unlike the GET serve route, which is exempt from the
    // bridge key because transformers.js' internal fetch cannot carry a header.
    // Nothing here is fetched by transformers.js, so nothing here is exempt.
    //
    // FROZEN CONTRACT: { files: string[] } → 200 { data: <job status> }. Every
    // path is confined with the SAME traversal defense the serve route uses.
    // Returns immediately; the transfer is a background job polled via the GET
    // sibling below. Singleton per model id: a POST during a running job
    // returns that job.
    method: 'POST',
    pattern: MODEL_FETCH_PATTERN,
    authRequired: true,
    handle: async (request, _requestId, match) => {
      const body = await readBody(request);
      return modelFetchResult(
        handleModelFetchStart(match.modelOrg ?? '', match.modelRepo ?? '', body),
      );
    },
  },
  {
    // MODEL FETCH STATUS — GET /v1/models/{org}/{repo}/fetch. A pure read of
    // the in-process job registry; starts nothing, contacts nothing. A model id
    // with no job reads state 'idle'.
    //
    // This path sits under the model-host prefix but is NOT claimed by the
    // streaming interception: isModelHostPath matches the /resolve/ shape only,
    // precisely so this status read stays behind the auth gate.
    method: 'GET',
    pattern: MODEL_FETCH_PATTERN,
    authRequired: true,
    handle: async (_request, _requestId, match) =>
      modelFetchResult(handleModelFetchStatus(match.modelOrg ?? '', match.modelRepo ?? '')),
  },
];
