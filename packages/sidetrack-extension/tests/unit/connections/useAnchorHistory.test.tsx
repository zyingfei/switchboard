import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useAnchorHistory } from '../../../src/sidepanel/connections/useAnchorHistory';

describe('useAnchorHistory', () => {
  it('starts with the initial anchor and no history', () => {
    const { result } = renderHook(() => useAnchorHistory('workstream:a'));
    expect(result.current.current).toBe('workstream:a');
    expect(result.current.canBack).toBe(false);
    expect(result.current.canForward).toBe(false);
  });

  it('navigate pushes onto the past stack and enables back', () => {
    const { result } = renderHook(() => useAnchorHistory('workstream:a'));
    act(() => {
      result.current.navigate('workstream:b');
    });
    expect(result.current.current).toBe('workstream:b');
    expect(result.current.canBack).toBe(true);
    expect(result.current.canForward).toBe(false);
  });

  it('back/forward round-trips between anchors and tracks both ends', () => {
    const { result } = renderHook(() => useAnchorHistory('a'));
    act(() => {
      result.current.navigate('b');
    });
    act(() => {
      result.current.navigate('c');
    });
    expect(result.current.current).toBe('c');
    act(() => {
      result.current.back();
    });
    expect(result.current.current).toBe('b');
    expect(result.current.canBack).toBe(true);
    expect(result.current.canForward).toBe(true);
    act(() => {
      result.current.back();
    });
    expect(result.current.current).toBe('a');
    expect(result.current.canBack).toBe(false);
    expect(result.current.canForward).toBe(true);
    act(() => {
      result.current.forward();
    });
    expect(result.current.current).toBe('b');
  });

  it('navigating after back wipes the forward stack (browser semantics)', () => {
    const { result } = renderHook(() => useAnchorHistory('a'));
    act(() => {
      result.current.navigate('b');
    });
    act(() => {
      result.current.navigate('c');
    });
    act(() => {
      result.current.back();
    });
    expect(result.current.canForward).toBe(true);
    act(() => {
      result.current.navigate('d');
    });
    expect(result.current.current).toBe('d');
    expect(result.current.canForward).toBe(false);
  });

  it('navigating to the same anchor is a no-op', () => {
    const { result } = renderHook(() => useAnchorHistory('a'));
    act(() => {
      result.current.navigate('a');
    });
    expect(result.current.canBack).toBe(false);
  });
});
