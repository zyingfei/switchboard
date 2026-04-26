export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly correlationId: string;
  readonly detail?: string;
  readonly instance?: string;
  readonly errors?: readonly {
    readonly path: string;
    readonly message: string;
  }[];
}

export interface ValidationIssue {
  readonly path: readonly (string | number | symbol)[];
  readonly message: string;
}

export const createProblem = (input: {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly correlationId: string;
  readonly detail?: string;
  readonly instance?: string;
  readonly issues?: readonly ValidationIssue[];
}): Problem => {
  const errors = input.issues?.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));

  return {
    type: `https://sidetrack.local/problems/${input.code.toLowerCase().replaceAll('_', '-')}`,
    title: input.title,
    status: input.status,
    code: input.code,
    correlationId: input.correlationId,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    ...(input.instance === undefined ? {} : { instance: input.instance }),
    ...(errors === undefined ? {} : { errors }),
  };
};
