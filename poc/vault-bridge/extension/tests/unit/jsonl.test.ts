import { buildSyntheticEvent, dateKey, toJsonLine } from '../../src/shared/jsonl';

describe('vault bridge JSONL helpers', () => {
  it('uses local YYYY-MM-DD names for daily event logs', () => {
    expect(dateKey(new Date(2026, 3, 26, 23, 59, 59))).toBe('2026-04-26');
  });

  it('renders one complete JSON line with a trailing newline', () => {
    expect(toJsonLine({ ok: true })).toBe('{"ok":true}\n');
  });

  it('builds synthetic capture events with the expected payload shape', () => {
    const event = buildSyntheticEvent(7, 'manual', new Date('2026-04-26T12:00:00.000Z'));
    expect(event).toMatchObject({
      timestamp: '2026-04-26T12:00:00.000Z',
      sequenceNumber: 7,
      payload: 'synthetic',
      source: 'manual',
    });
  });
});
