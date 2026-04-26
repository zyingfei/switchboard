const quote = (value: string): string => `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;

export interface WhereWasIBaseOptions {
  project: string;
}

export const buildWhereWasIBase = ({ project }: WhereWasIBaseOptions): string =>
  [
    'filters:',
    '  and:',
    '    - bac_type == "thread"',
    `    - project == ${quote(project)}`,
    '    - status != "archived"',
    'properties:',
    '  title:',
    '    displayName: Title',
    '  provider:',
    '    displayName: Provider',
    '  project:',
    '    displayName: Project',
    '  topic:',
    '    displayName: Topic',
    '  status:',
    '    displayName: Status',
    '  bac_id:',
    '    displayName: BAC ID',
    'views:',
    '  - type: table',
    '    name: Where Was I',
    '    order:',
    '      - title',
    '      - provider',
    '      - project',
    '      - topic',
    '      - status',
    '      - bac_id',
    '',
  ].join('\n');

export const baseMentionsProjectFilter = (baseContent: string, project: string): boolean =>
  baseContent.includes(`project == ${quote(project)}`) && baseContent.includes('bac_type == "thread"');
