import type { BrandingPreview } from '@p2p/sdk-bridge';
import type { Branding } from './types';

/** Maps the bank's branding to CSS custom properties; everything else in the stylesheet derives from these. */
export function themeVars(b: Branding): Record<string, string> {
  const c = b.colors;
  const vars: Record<string, string> = {
    '--c-primary': c.primary ?? '#0B5FFF',
    '--c-on-primary': c.onPrimary ?? '#FFFFFF',
    '--c-bg': c.background ?? '#FFFFFF',
    '--c-text': c.text ?? '#111827',
    '--c-buy': c.buy ?? '#059669',
    '--c-sell': c.sell ?? '#DC2626',
    '--radius': `${b.radius ?? 12}px`,
    '--font': b.font ? `${b.font}, system-ui, sans-serif` : 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  };
  if (c.surface) vars['--c-surface'] = c.surface;
  if (c.header) vars['--c-header'] = c.header;
  return vars;
}

export function applyTheme(b: Branding, root: HTMLElement = document.documentElement) {
  for (const [k, v] of Object.entries(themeVars(b))) root.style.setProperty(k, v);
  document.title = b.productName;
}

/** Applies a host-supplied branding preview on top of the deployment's branding (demo builds only). */
export function mergeBranding(base: Branding, preview?: BrandingPreview): Branding {
  if (!preview) return base;
  const { bankName: _, ...fields } = preview;
  return {
    ...base,
    ...fields,
    colors: { ...base.colors, ...preview.colors },
    strings: base.strings,
    locale: base.locale,
  };
}
