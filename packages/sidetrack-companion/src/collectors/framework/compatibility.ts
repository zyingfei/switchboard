export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: string;
  readonly build?: string;
}

const semverPattern =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export const parseSemVer = (s: string): SemVer | null => {
  const match = semverPattern.exec(s.trim());
  if (match === null) return null;

  const major = match[1];
  const minor = match[2];
  const patch = match[3];
  if (major === undefined || minor === undefined || patch === undefined) return null;

  const parsed = {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
  };
  const prerelease = match[4];
  const build = match[5];

  if (prerelease !== undefined && build !== undefined) return { ...parsed, prerelease, build };
  if (prerelease !== undefined) return { ...parsed, prerelease };
  if (build !== undefined) return { ...parsed, build };
  return parsed;
};

const compareIdentifiers = (left: string, right: string): number => {
  const leftNumeric = /^[0-9]+$/.test(left);
  const rightNumeric = /^[0-9]+$/.test(right);

  if (leftNumeric && rightNumeric) {
    const leftNumber = Number.parseInt(left, 10);
    const rightNumber = Number.parseInt(right, 10);
    if (leftNumber !== rightNumber) return leftNumber - rightNumber;
    return 0;
  }
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
};

const comparePrerelease = (left?: string, right?: string): number => {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;

  const leftParts = left.split('.');
  const rightParts = right.split('.');
  const count = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < count; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;

    const compared = compareIdentifiers(leftPart, rightPart);
    if (compared !== 0) return compared;
  }

  return 0;
};

const compareSemVer = (left: SemVer, right: SemVer): number => {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  return comparePrerelease(left.prerelease, right.prerelease);
};

const compareVersionStrings = (left: string, right: string): number | null => {
  const leftVersion = parseSemVer(left);
  const rightVersion = parseSemVer(right);
  if (leftVersion === null || rightVersion === null) return null;
  return compareSemVer(leftVersion, rightVersion);
};

export const lt = (left: string, right: string): boolean => {
  const compared = compareVersionStrings(left, right);
  return compared !== null && compared < 0;
};

export const lte = (left: string, right: string): boolean => {
  const compared = compareVersionStrings(left, right);
  return compared !== null && compared <= 0;
};

export const gt = (left: string, right: string): boolean => {
  const compared = compareVersionStrings(left, right);
  return compared !== null && compared > 0;
};

export const gte = (left: string, right: string): boolean => {
  const compared = compareVersionStrings(left, right);
  return compared !== null && compared >= 0;
};

export const eq = (left: string, right: string): boolean => {
  const compared = compareVersionStrings(left, right);
  return compared !== null && compared === 0;
};

const caretUpperBound = (version: SemVer): SemVer => {
  if (version.major > 0) return { major: version.major + 1, minor: 0, patch: 0 };
  if (version.minor > 0) return { major: 0, minor: version.minor + 1, patch: 0 };
  return { major: 0, minor: 0, patch: version.patch + 1 };
};

const tildeUpperBound = (version: SemVer): SemVer => ({
  major: version.major,
  minor: version.minor + 1,
  patch: 0,
});

const satisfiesSingleConstraint = (candidate: SemVer, token: string): boolean => {
  if (token.length === 0) return true;

  if (token.startsWith('^')) {
    const lower = parseSemVer(token.slice(1));
    if (lower === null) return false;
    const upper = caretUpperBound(lower);
    return compareSemVer(candidate, lower) >= 0 && compareSemVer(candidate, upper) < 0;
  }

  if (token.startsWith('~')) {
    const lower = parseSemVer(token.slice(1));
    if (lower === null) return false;
    const upper = tildeUpperBound(lower);
    return compareSemVer(candidate, lower) >= 0 && compareSemVer(candidate, upper) < 0;
  }

  const operatorMatch = /^(>=|>|<=|<|=)?(.+)$/.exec(token);
  if (operatorMatch === null) return false;

  const operator = operatorMatch[1] ?? '=';
  const rawTarget = operatorMatch[2];
  if (rawTarget === undefined) return false;

  const target = parseSemVer(rawTarget);
  if (target === null) return false;

  const compared = compareSemVer(candidate, target);
  switch (operator) {
    case '>=':
      return compared >= 0;
    case '>':
      return compared > 0;
    case '<=':
      return compared <= 0;
    case '<':
      return compared < 0;
    case '=':
      return compared === 0;
    default:
      return false;
  }
};

export const satisfies = (version: string, range: string): boolean => {
  const candidate = parseSemVer(version);
  if (candidate === null) return false;

  const tokens = range.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((token) => satisfiesSingleConstraint(candidate, token));
};
