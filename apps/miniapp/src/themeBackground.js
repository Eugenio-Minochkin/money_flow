const THEME_BACKGROUNDS = {
  light: "#f8f6f1",
  dark: "#0a0f0f"
};

export function applyMiniAppTheme(theme, { documentElement, body, webApp }) {
  const resolvedTheme = theme === "dark" ? "dark" : "light";
  const background = THEME_BACKGROUNDS[resolvedTheme];
  documentElement.dataset.theme = resolvedTheme;
  body.dataset.theme = resolvedTheme;
  documentElement.style.backgroundColor = background;
  body.style.backgroundColor = background;
  try { webApp?.setBackgroundColor?.(background); } catch { /* optional Telegram capability */ }
  return resolvedTheme;
}
