import { describe, it, expect } from 'vitest';
import { breakpointFromWidth, isCompactViewport, isPhoneViewport, BREAKPOINT_MD_PX, BREAKPOINT_LG_PX, BREAKPOINT_SM_PX } from '../components/mobile/mobileUtils';

describe('breakpointFromWidth', () => {
  it('maps sm below 640', () => {
    expect(breakpointFromWidth(0)).toBe('sm');
    expect(breakpointFromWidth(BREAKPOINT_SM_PX - 1)).toBe('sm');
  });

  it('maps md 640–767', () => {
    expect(breakpointFromWidth(BREAKPOINT_SM_PX)).toBe('md');
    expect(breakpointFromWidth(BREAKPOINT_MD_PX - 1)).toBe('md');
  });

  it('maps lg 768–1023', () => {
    expect(breakpointFromWidth(BREAKPOINT_MD_PX)).toBe('lg');
    expect(breakpointFromWidth(BREAKPOINT_LG_PX - 1)).toBe('lg');
  });

  it('maps xl at 1024+', () => {
    expect(breakpointFromWidth(BREAKPOINT_LG_PX)).toBe('xl');
    expect(breakpointFromWidth(2000)).toBe('xl');
  });
});

describe('viewport helpers', () => {
  it('compact below lg', () => {
    expect(isCompactViewport(BREAKPOINT_LG_PX - 1)).toBe(true);
    expect(isCompactViewport(BREAKPOINT_LG_PX)).toBe(false);
  });

  it('phone below md', () => {
    expect(isPhoneViewport(BREAKPOINT_MD_PX - 1)).toBe(true);
    expect(isPhoneViewport(BREAKPOINT_MD_PX)).toBe(false);
  });
});
