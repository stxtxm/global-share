// Notes de version (« patch notes ») affichées dans l’encart de mise à jour
// avant de télécharger ou d’installer. Les sources sont hétérogènes :
//
// - `web-bundle.json` (desktop + Android) contient un extrait Markdown du
//   CHANGELOG généré par scripts/web-bundle.mjs ;
// - electron-updater relaie le contenu HTML du flux GitHub ;
// - Android lit le champ `body` de l’API GitHub.
//
// Tout est ramené à un texte simple ici, puis découpé en sections affichables.
// Aucun HTML n’est injecté dans le DOM : le rendu se fait en composants React.

export interface ReleaseNotesSection {
  title: string;
  items: string[];
}

const MAX_NOTES_LENGTH = 8000;
const MAX_ITEMS_PER_SECTION = 12;
const MAX_ITEM_LENGTH = 320;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    if (name.startsWith('#')) {
      const code = Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, name.toLowerCase())
      ? ENTITIES[name.toLowerCase()]
      : match;
  });
}

/**
 * Réduit les notes à du texte simple : les listes HTML deviennent des
 * puces Markdown, les autres balises disparaissent, les entités sont décodées.
 */
export function plainReleaseNotes(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  const text = value
    .replace(/\r\n?/g, '\n')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<h[1-6][^>]*>/gi, '\n### ')
    .replace(/<\/(p|li|h[1-6]|ul|ol|div)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/\u00a0/g, ' ');
  return decodeEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_NOTES_LENGTH);
}

const SECTION_LABELS: Record<string, string> = {
  added: 'Nouveautés',
  add: 'Nouveautés',
  feat: 'Nouveautés',
  features: 'Nouveautés',
  new: 'Nouveautés',
  changed: 'Améliorations',
  improved: 'Améliorations',
  updated: 'Améliorations',
  fixed: 'Corrections',
  fix: 'Corrections',
  removed: 'Retiré',
  deprecated: 'Déprécié',
  security: 'Sécurité',
};

function cleanInline(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sectionLabel(raw: string): string {
  const key = raw.toLowerCase().trim();
  return SECTION_LABELS[key] ?? cleanInline(raw) ?? '';
}

/**
 * Découpe les notes en sections (Nouveautés, Corrections…) et puces. Le
 * Markdown du CHANGELOG comme le HTML de GitHub donne le même résultat.
 */
export function parseReleaseNotes(value: string): ReleaseNotesSection[] {
  const plain = plainReleaseNotes(value);
  if (!plain) return [];

  const sections: ReleaseNotesSection[] = [];
  let current: ReleaseNotesSection | null = null;

  const ensure = (title = 'Nouveautés'): ReleaseNotesSection => {
    if (!current) {
      current = { title, items: [] };
      sections.push(current);
    }
    return current;
  };

  for (const rawLine of plain.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // Titre de version « ## [1.0.51] - date » : déjà porté par l’encart.
    if (/^#{1,2}\s/.test(line)) continue;
    if (line.startsWith('###')) {
      const title = sectionLabel(line.replace(/^#+\s*/, ''));
      current = { title, items: [] };
      sections.push(current);
      continue;
    }
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    const text = cleanInline(bullet ? bullet[1] : line);
    if (!text) continue;
    const section = ensure();
    if (section.items.length >= MAX_ITEMS_PER_SECTION) continue;
    section.items.push(text.slice(0, MAX_ITEM_LENGTH));
  }

  return sections.filter((section) => section.items.length > 0 && section.title);
}
