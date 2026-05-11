export const createProblem = (input) => {
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
//# sourceMappingURL=problem.js.map