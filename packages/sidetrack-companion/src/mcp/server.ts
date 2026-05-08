import {
  EXPLAIN_RANKING_TOOL_NAME,
  explainRanking,
  explainRankingInputSchemaShape,
  type ExplainRankingDeps,
  type ExplainRankingOutput,
} from './explainRanking.js';

export interface CompanionMcpToolResult {
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }];
  readonly structuredContent: Record<string, unknown>;
}

export type CompanionMcpToolHandler = (input: unknown) => Promise<CompanionMcpToolResult>;

export interface CompanionMcpToolDefinition {
  readonly title: string;
  readonly description: string;
  readonly inputSchema: typeof explainRankingInputSchemaShape;
  readonly annotations: {
    readonly readOnlyHint: true;
    readonly destructiveHint: false;
    readonly idempotentHint: true;
  };
}

export interface CompanionMcpToolRegistry {
  readonly registerTool: (
    name: typeof EXPLAIN_RANKING_TOOL_NAME,
    definition: CompanionMcpToolDefinition,
    handler: CompanionMcpToolHandler,
  ) => void;
}

const toolText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const outputRecord = (value: ExplainRankingOutput): Record<string, unknown> => ({
  features: value.features,
  modelVersion: value.modelVersion,
  revisionId: value.revisionId,
  score: value.score,
  contributions: value.contributions,
  sortedReasonCodes: value.sortedReasonCodes,
});

export const asStructuredContent = (value: Record<string, unknown>): CompanionMcpToolResult => ({
  content: [{ type: 'text', text: toolText(value) }],
  structuredContent: value,
});

export const registerExplainRankingTool = (
  registry: CompanionMcpToolRegistry,
  deps: ExplainRankingDeps,
): void => {
  registry.registerTool(
    EXPLAIN_RANKING_TOOL_NAME,
    {
      title: 'Explain ranking',
      description:
        'Read-only debug tool that rebuilds closest-visit ranker features for a visit pair and returns model score, contributions, and reason codes.',
      inputSchema: explainRankingInputSchemaShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (input) => asStructuredContent(outputRecord(await explainRanking(input, deps))),
  );
};

export const registerCompanionMcpTools = (
  registry: CompanionMcpToolRegistry,
  deps: ExplainRankingDeps,
): void => {
  registerExplainRankingTool(registry, deps);
};
