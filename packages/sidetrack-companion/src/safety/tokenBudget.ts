export const tokenBudgetWarningThreshold = 8000;

export const estimateTokens = (input: string): number => Math.ceil(input.length / 4);
