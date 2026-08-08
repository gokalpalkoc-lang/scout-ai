/**
 * Design tokens for Scout.
 *
 * One source of truth for colour, spacing, radius and type. Screens never
 * hardcode a hex value — they read from `useTheme()` so light/dark stay in sync.
 */

export type ColorScheme = 'light' | 'dark';

export interface Palette {
  /** App background, furthest back. */
  bg: string;
  /** Slightly raised background (grouped list backdrop). */
  bgSubtle: string;
  /** Card / sheet surface. */
  surface: string;
  /** Surface one step up (nested card, input). */
  surfaceAlt: string;
  /** Pressed / hovered surface. */
  surfacePressed: string;

  border: string;
  borderStrong: string;

  text: string;
  textSecondary: string;
  textMuted: string;
  textInverse: string;

  /** Primary brand — actions, active tab, links. */
  primary: string;
  primaryPressed: string;
  primarySoft: string;
  onPrimary: string;

  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
  info: string;
  infoSoft: string;

  /** Accent used for "new since last check" highlights. */
  accent: string;
  accentSoft: string;

  overlay: string;
  shadow: string;
}

const dark: Palette = {
  bg: '#0B1220',
  bgSubtle: '#0E1626',
  surface: '#141E33',
  surfaceAlt: '#1B2740',
  surfacePressed: '#22304D',

  border: '#22304D',
  borderStrong: '#324566',

  text: '#EEF3FB',
  textSecondary: '#A8B7D1',
  textMuted: '#6F80A0',
  textInverse: '#0B1220',

  primary: '#5B9DF9',
  primaryPressed: '#4183E0',
  primarySoft: '#16294A',
  onPrimary: '#04101F',

  success: '#3FD08A',
  successSoft: '#0F2C22',
  warning: '#F5B84C',
  warningSoft: '#33260D',
  danger: '#F6685E',
  dangerSoft: '#361A1B',
  info: '#63C9E8',
  infoSoft: '#0D2A33',

  accent: '#A88BFA',
  accentSoft: '#231C3D',

  overlay: 'rgba(3, 7, 15, 0.72)',
  shadow: '#000000',
};

const light: Palette = {
  bg: '#F6F8FC',
  bgSubtle: '#EDF1F8',
  surface: '#FFFFFF',
  surfaceAlt: '#F3F6FB',
  surfacePressed: '#E6ECF6',

  border: '#DFE5EF',
  borderStrong: '#C4CEDE',

  text: '#101828',
  textSecondary: '#4A5568',
  textMuted: '#7C8899',
  textInverse: '#FFFFFF',

  primary: '#2D6FE0',
  primaryPressed: '#2559B8',
  primarySoft: '#E7EFFD',
  onPrimary: '#FFFFFF',

  success: '#12805C',
  successSoft: '#E1F5EC',
  warning: '#9A6100',
  warningSoft: '#FDF1DC',
  danger: '#C3352B',
  dangerSoft: '#FCE9E7',
  info: '#0E6E86',
  infoSoft: '#E1F3F8',

  accent: '#6B4EE6',
  accentSoft: '#EDE8FD',

  overlay: 'rgba(16, 24, 40, 0.45)',
  shadow: '#1B2740',
};

export const palettes: Record<ColorScheme, Palette> = { light, dark };

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  pill: 999,
} as const;

export const fontSize = {
  xs: 11,
  sm: 13,
  base: 15,
  md: 17,
  lg: 20,
  xl: 24,
  xxl: 30,
} as const;

export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

/** Consistent elevation recipe (Android uses `elevation`, iOS uses shadow*). */
export function elevation(level: 0 | 1 | 2 | 3, shadowColor: string) {
  if (level === 0) return {};
  const map = {
    1: { radius: 6, opacity: 0.1, offset: 2 },
    2: { radius: 14, opacity: 0.16, offset: 5 },
    3: { radius: 26, opacity: 0.24, offset: 10 },
  } as const;
  const m = map[level];
  return {
    shadowColor,
    shadowOpacity: m.opacity,
    shadowRadius: m.radius,
    shadowOffset: { width: 0, height: m.offset },
    elevation: level * 3,
  };
}
