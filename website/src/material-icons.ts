import paths from './material-icon-paths';

export function iconPath(name: string, filled = false): string {
  const icon = paths[name as keyof typeof paths];
  if (!icon) throw new Error(`Missing local icon: ${name}`);
  return filled ? icon.filled : icon.outline;
}

// Keep the Stitch classes, layout and original outlines; remove font ligatures.
export function inlineMaterialIcons(html: string): string {
  return html.replace(/<span\b([^>]*\bclass="[^"]*\bmaterial-symbols-outlined\b[^"]*"[^>]*)>([a-z0-9_]+)<\/span>/g,
    (_match, attributes: string, name: string) => {
      const attrs = attributes.replace(/\sdata-icon="[^"]*"/g, '');
      const path = iconPath(name, attributes.includes('icon-filled'));
      return `<svg${attrs} data-icon="${name}" viewBox="0 0 960 960" fill="currentColor" aria-hidden="true" focusable="false"><path transform="translate(0 960) scale(1 -1)" d="${path}" /></svg>`;
    });
}
