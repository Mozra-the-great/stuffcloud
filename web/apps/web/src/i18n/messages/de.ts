import type { Message } from '../types.ts';
import type { MessageKey } from './en.ts';

/** German catalogue: exactly the keys of `en.ts` (the type makes a missing or extra key a compile error). */
export const de: Readonly<Record<MessageKey, Message>> = {
  'skip.toContent': 'Zum Inhalt springen',

  'nav.main': 'Hauptnavigation',
  'nav.tools': 'Tools',
  'nav.menuOpen': 'Menü öffnen',
  'nav.menuClose': 'Menü schließen',

  'search.open': 'Tools durchsuchen',
  'search.title': 'Tools durchsuchen',
  'search.label': 'Suche',
  'search.close': 'Schließen',
  'search.results': 'Suchergebnisse',
  'search.none': 'Keine Tools gefunden',
  'search.count': { one: '{count} Tool gefunden', other: '{count} Tools gefunden' },

  'language.label': 'Sprache',

  'footer.tagline': 'GPL-3.0 · keine Tracker',
  'footer.source': 'Quellcode',

  'offline.title': 'Keine Verbindung',
  'offline.hint': 'Bereits geöffnete Tools funktionieren weiter.',

  'status.loading': 'Seite wird geladen',
  'status.navigated': 'Gewechselt zu {title}',
  'toast.region': 'Benachrichtigungen',
  'toast.dismiss': 'Schließen',

  'home.title': 'Deine Sachen in deiner Cloud.',
  'home.openTools': 'Tools öffnen',

  'tools.title': 'Tools',
  'tools.categories': 'Kategorien',
  'tools.all': 'Alle',
  'tools.empty': 'Noch keine Tools',
  'tools.count': { one: '{count} Tool', other: '{count} Tools' },

  'tool.localOnly': 'Deine Dateien bleiben in diesem Browser. Es wird nichts hochgeladen.',
  'tool.unsupported': 'Dieser Browser kann dieses Tool nicht ausführen. Es fehlt: {features}.',
  'capability.wasm': 'WebAssembly',
  'capability.webcrypto': 'Web Crypto (braucht eine sichere Verbindung)',
  'capability.worker': 'Web Workers',

  'category.pdf': 'PDF',
  'category.image': 'Bilder',
  'category.convert': 'Konvertieren',
  'category.parse': 'Auswerten',
  'category.network': 'Netzwerk',
  'category.text': 'Text',
  'category.extra': 'Extras',

  'notFound.title': 'Hier ist nichts',
  'notFound.home': 'Zu stuffcloud',

  'error.title': 'Etwas ist schiefgegangen',
  'error.retry': 'Erneut versuchen',
};
