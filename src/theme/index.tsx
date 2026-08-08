import React, { createContext, useContext, useMemo } from 'react';
import { useColorScheme } from 'react-native';

import {
  ColorScheme,
  Palette,
  elevation,
  fontSize,
  fontWeight,
  palettes,
  radius,
  spacing,
} from './tokens';

export type ThemePreference = 'system' | 'light' | 'dark';

export interface Theme {
  scheme: ColorScheme;
  color: Palette;
  spacing: typeof spacing;
  radius: typeof radius;
  fontSize: typeof fontSize;
  fontWeight: typeof fontWeight;
  elevation: (level: 0 | 1 | 2 | 3) => object;
}

function buildTheme(scheme: ColorScheme): Theme {
  const color = palettes[scheme];
  return {
    scheme,
    color,
    spacing,
    radius,
    fontSize,
    fontWeight,
    elevation: (level) => elevation(level, color.shadow),
  };
}

const ThemeContext = createContext<Theme>(buildTheme('dark'));

export function ThemeProvider({
  preference,
  children,
}: {
  preference: ThemePreference;
  children: React.ReactNode;
}) {
  const system = useColorScheme();
  const scheme: ColorScheme =
    preference === 'system' ? (system === 'light' ? 'light' : 'dark') : preference;

  const theme = useMemo(() => buildTheme(scheme), [scheme]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

export * from './tokens';
