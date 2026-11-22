// Le thème pilote à la fois les classes CSS et les métadonnées natives du
// WebView (theme-color / color-scheme) : c'est ce dernier point qui évite la
// barre de navigation noire sous Android en mode clair.
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAppearance, applyTheme, resolveTheme, syncSystemTheme } from '../app/lib/settings.ts';
import { DEFAULT_SETTINGS } from '../app/lib/settings.ts';

function fakeDocument(systemDark: boolean) {
  const classes = new Set<string>();
  const meta = new Map<string, { name: string; content: string }>([
    ['theme-color', { name: 'theme-color', content: '#0a0b10' }],
    ['color-scheme', { name: 'color-scheme', content: 'dark' }],
  ]);
  const setProperty = (key: string, value: string) => void meta.set(key, { name: key, content: value });
  const documentElement = {
    classList: {
      toggle: (name: string, force: boolean) => force ? classes.add(name) : classes.delete(name),
      contains: (name: string) => classes.has(name),
    },
    dataset: {} as Record<string, string>,
    style: { colorScheme: '', setProperty },
    lang: '',
  };
  const doc = {
    documentElement,
    head: { appendChild: (element: { name: string }) => void meta.set(element.name, { name: element.name, content: '' }) },
    createElement: (tag: string) => ({ name: tag === 'meta' ? '' : tag, content: '' }),
    querySelector: (selector: string) => {
      const name = /name="([^"]+)"/.exec(selector)?.[1];
      return name ? meta.get(name) ?? null : null;
    },
  };
  (globalThis as { document?: unknown }).document = doc;
  (globalThis as { window?: unknown }).window = {
    matchMedia: () => ({ matches: systemDark }),
  };
  return { classes, meta, doc, documentElement };
}

test('resolveTheme respecte le choix explicite et interroge le système en Auto', () => {
  assert.equal(resolveTheme('light'), 'light');
  assert.equal(resolveTheme('dark'), 'dark');
  fakeDocument(true);
  assert.equal(resolveTheme('system'), 'dark');
  fakeDocument(false);
  assert.equal(resolveTheme('system'), 'light');
});

test('applyTheme(clair) pose la classe claire et une theme-color claire', () => {
  const env = fakeDocument(false);
  applyTheme('light');
  assert.ok(env.classes.has('gs-theme--light'));
  assert.ok(!env.classes.has('gs-theme--dark'));
  assert.equal(env.documentElement.dataset.theme, 'light');
  assert.equal(env.documentElement.style.colorScheme, 'light');
  assert.equal(env.meta.get('theme-color')?.content, '#eef0f7');
  assert.equal(env.meta.get('color-scheme')?.content, 'light');
});

test('applyTheme(sombre) restaure une theme-color sombre', () => {
  const env = fakeDocument(false);
  applyTheme('dark');
  assert.ok(env.classes.has('gs-theme--dark'));
  assert.equal(env.meta.get('theme-color')?.content, '#0a0b10');
});

test('syncSystemTheme se contente de mettre à jour les métadonnées', () => {
  const env = fakeDocument(false);
  syncSystemTheme('light');
  assert.equal(env.documentElement.dataset.theme, 'light');
  assert.equal(env.meta.get('theme-color')?.content, '#eef0f7');
});

test('applyAppearance applique thème, accent et langue en une passe', () => {
  const env = fakeDocument(false);
  applyAppearance({ ...DEFAULT_SETTINGS, theme: 'light', language: 'es', accentColor: '#3b82f6' });
  assert.ok(env.classes.has('gs-theme--light'));
  assert.equal(env.documentElement.lang, 'es');
  assert.equal(env.meta.get('--gs-accent')?.content, '#3b82f6');
});
