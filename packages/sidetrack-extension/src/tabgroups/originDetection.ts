export type TabGroupOrigin = 'system-suggested' | 'user-created';

export interface TabGroupOriginDetector {
  readonly markSystemGroupCall: (groupId: number, atMs?: number) => void;
  readonly classify: (groupId: number, atMs?: number) => TabGroupOrigin;
}

export const createTabGroupOriginDetector = (
  windowMs = 200,
  clock: () => number = () => Date.now(),
): TabGroupOriginDetector => {
  const issuedAtByGroup = new Map<number, number>();
  return {
    markSystemGroupCall: (groupId, atMs = clock()) => {
      issuedAtByGroup.set(groupId, atMs);
    },
    classify: (groupId, atMs = clock()) => {
      const issuedAt = issuedAtByGroup.get(groupId);
      if (issuedAt === undefined) return 'user-created';
      issuedAtByGroup.delete(groupId);
      return atMs - issuedAt <= windowMs ? 'system-suggested' : 'user-created';
    },
  };
};
