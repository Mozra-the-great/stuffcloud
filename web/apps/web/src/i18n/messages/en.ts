import type { Message } from '../types.ts';

/**
 * English catalogue and the source of the message keys: `MessageKey` is derived from it, every
 * other locale must provide exactly these keys (checked by the compiler and by tests/i18n.test.ts,
 * which also fails on unused keys, placeholder mismatches and wrong plural forms).
 * Keys are `area.name`; `{name}` is a placeholder, plural messages read `{count}`.
 */
export const en = {
  'skip.toContent': 'Skip to content',

  'nav.main': 'Main',
  'nav.tools': 'Tools',
  'nav.menuOpen': 'Open menu',
  'nav.menuClose': 'Close menu',

  'search.open': 'Search tools',
  'search.title': 'Search tools',
  'search.label': 'Search',
  'search.close': 'Close',
  'search.results': 'Search results',
  'search.none': 'No tools found',
  'search.count': { one: '{count} tool found', other: '{count} tools found' },

  'language.label': 'Language',

  'footer.tagline': 'GPL-3.0 · no trackers',
  'footer.source': 'Source',

  'offline.title': 'No connection',
  'offline.hint': 'Tools you already opened keep working.',

  'status.loading': 'Loading page',
  'status.navigated': 'Navigated to {title}',
  'toast.region': 'Notifications',
  'toast.dismiss': 'Dismiss',

  'home.title': 'Your stuff, in your cloud.',
  'home.openTools': 'Open the tools',

  'tools.title': 'Tools',
  'tools.categories': 'Categories',
  'tools.all': 'All',
  'tools.empty': 'No tools yet',
  'tools.count': { one: '{count} tool', other: '{count} tools' },

  'tool.localOnly': 'Your files stay in this browser. Nothing is uploaded.',
  'tool.unsupported': 'This browser cannot run this tool. Missing: {features}.',
  'capability.wasm': 'WebAssembly',
  'capability.webcrypto': 'Web Crypto (needs a secure connection)',
  'capability.worker': 'Web Workers',

  'category.pdf': 'PDF',
  'category.image': 'Images',
  'category.convert': 'Convert',
  'category.parse': 'Parse',
  'category.network': 'Network',
  'category.text': 'Text',
  'category.extra': 'Extras',

  'notFound.title': 'Nothing here',
  'notFound.home': 'Go to stuffcloud',

  'error.title': 'Something went wrong',
  'error.retry': 'Try again',

  'tool.pdf-merge.name': 'Merge PDFs',
  'tool.pdf-merge.description':
    'Combine several PDFs into one, in the order you choose. Bookmarks and form fields are not carried over.',
  'tool.pdf-merge.keywords': 'pdf merge combine join append concatenate',

  'tool.pdf-split.name': 'Split PDF',
  'tool.pdf-split.description':
    'Cut a PDF into several files: by page ranges, every N pages or a selection of pages. Bookmarks and form fields are not carried over.',
  'tool.pdf-split.keywords': 'pdf split divide extract separate pages ranges',

  'tool.pdf-pages.name': 'Rotate, delete, reorder PDF pages',
  'tool.pdf-pages.description':
    'Turn, delete and reorder the pages of a PDF, with undo. Bookmarks and form fields are not carried over.',
  'tool.pdf-pages.keywords': 'pdf rotate turn delete remove reorder sort move pages',

  'pdf.drop.many': 'Drop PDFs here',
  'pdf.drop.manyButton': 'Choose PDFs',
  'pdf.drop.one': 'Drop a PDF here',
  'pdf.drop.oneButton': 'Choose a PDF',
  'pdf.drop.notPdf': {
    one: '{count} file was skipped because it is not a PDF.',
    other: '{count} files were skipped because they are not PDFs.',
  },
  'pdf.file.meta': { one: '{count} page · {size}', other: '{count} pages · {size}' },
  'pdf.action.cancel': 'Cancel',
  'pdf.action.download': 'Download',
  'pdf.progress': 'Progress',
  'pdf.progress.steps': '{completed} of {total} steps',
  'pdf.move.up': 'Up',
  'pdf.move.down': 'Down',
  'pdf.remove': 'Remove',
  'pdf.issue.encrypted':
    '{name} is protected with a password or encrypted. Remove the protection first, then try again.',
  'pdf.issue.broken': '{name} could not be read: it is damaged or not a PDF.',
  'pdf.issue.empty': '{name} has no pages.',
  'pdf.issue.tooLarge':
    '{name} is too large to work on in this browser tab. The limit is {size} of files and {pages} pages at a time.',
  'pdf.issue.memory':
    'The browser ran out of memory while working on {name}. Close other tabs or use a smaller file.',
  'pdf.issue.theFiles': 'the files',
  'pdf.issue.failed':
    'Something went wrong while working on the PDF. Nothing was uploaded. Please try again.',
  'pdf.merge.list': 'PDFs to merge, in this order',
  'pdf.merge.reading': 'Reading file…',
  'pdf.merge.upLabel': 'Move {name} up',
  'pdf.merge.downLabel': 'Move {name} down',
  'pdf.merge.removeLabel': 'Remove {name}',
  'pdf.merge.moved': '{name} is now number {position} of {total}.',
  'pdf.merge.removed': '{name} removed.',
  'pdf.merge.cleared': 'All files removed.',
  'pdf.merge.added': { one: '{count} PDF added.', other: '{count} PDFs added.' },
  'pdf.merge.refused':
    'Some files were not added: at most {max} files and {size} together can be merged at once.',
  'pdf.merge.start': 'Merge',
  'pdf.merge.clear': 'Remove all',
  'pdf.merge.needTwo': 'Add at least two PDFs to merge them.',
  'pdf.merge.working': 'Merging…',
  'pdf.merge.done': 'Merged {files} files into one PDF: {pages} pages, {size}.',
  'pdf.merge.cancelled': 'Merge cancelled.',
  'pdf.split.reading': 'Reading {name}…',
  'pdf.split.opened': {
    one: '{name} opened: {count} page.',
    other: '{name} opened: {count} pages.',
  },
  'pdf.split.mode': 'Split by',
  'pdf.split.mode.ranges': 'Page ranges',
  'pdf.split.mode.every': 'Every N pages',
  'pdf.split.mode.selection': 'Selected pages',
  'pdf.split.rangesLabel': 'Page ranges',
  'pdf.split.rangesHint': 'For example 1-3, 5, 8-. Each range becomes its own PDF.',
  'pdf.split.everyLabel': 'Pages per file',
  'pdf.split.everyHint': 'The last file may have fewer pages.',
  'pdf.split.everyError': 'Enter a whole number from 1 to {max}.',
  'pdf.split.selectHint': 'Select the pages you want. They become one new PDF.',
  'pdf.split.grid': 'Pages of {name}',
  'pdf.split.pageLabel': 'Page {page}',
  'pdf.split.selected': { one: '{count} page selected', other: '{count} pages selected' },
  'pdf.split.preview': { one: 'This makes {count} file.', other: 'This makes {count} files.' },
  'pdf.split.start': 'Split',
  'pdf.split.working': 'Splitting…',
  'pdf.split.cancelled': 'Split cancelled.',
  'pdf.split.done': { one: 'Created {count} PDF.', other: 'Created {count} PDFs.' },
  'pdf.split.results': 'Result files',
  'pdf.split.zip': 'Download all as ZIP ({size})',
  'pdf.split.downloadFile': 'Download {name}',
  'pdf.range.empty': 'Enter at least one page or range.',
  'pdf.range.syntax': '“{text}” is not a page or a range.',
  'pdf.range.reversed': '“{text}” runs backwards: write the smaller page first.',
  'pdf.range.outside': 'Page {page} does not exist: this PDF has {total} pages.',
  'pdf.range.tooMany': 'That would make more than {max} files.',
  'pdf.pages.keys':
    'Arrow keys move between pages, Space selects, Shift extends the selection, Ctrl+A selects all. With Alt and an arrow key the page moves.',
  'pdf.pages.summary': {
    one: '{count} of {total} page kept',
    other: '{count} of {total} pages kept',
  },
  'pdf.pages.actions': 'Page actions',
  'pdf.pages.group.select': 'Selection',
  'pdf.pages.group.turn': 'Turn and delete',
  'pdf.pages.group.move': 'Order',
  'pdf.pages.group.history': 'History',
  'pdf.pages.selectAll': 'Select all',
  'pdf.pages.selectNone': 'Select none',
  'pdf.pages.turnLeft': 'Turn left',
  'pdf.pages.turnRight': 'Turn right',
  'pdf.pages.delete': 'Delete',
  'pdf.pages.earlier': 'Move earlier',
  'pdf.pages.later': 'Move later',
  'pdf.pages.toStart': 'To the start',
  'pdf.pages.toEnd': 'To the end',
  'pdf.pages.position': 'Move selected pages to position',
  'pdf.pages.moveHere': 'Move',
  'pdf.pages.positionError': 'Enter a whole number from 1 to {max}.',
  'pdf.pages.undo': 'Undo',
  'pdf.pages.redo': 'Redo',
  'pdf.pages.nothingToUndo': 'Nothing to undo.',
  'pdf.pages.nothingToRedo': 'Nothing to redo.',
  'pdf.pages.undone': 'Undone: {action}',
  'pdf.pages.redone': 'Redone: {action}',
  'pdf.pages.needSelection': 'Select one or more pages first.',
  'pdf.pages.none': 'All pages are deleted. Undo to bring them back.',
  'pdf.pages.unchanged': 'The PDF is unchanged so far.',
  'pdf.pages.pageLabel': 'Position {position}: page {page}',
  'pdf.pages.pageLabelTurned':
    'Position {position}: page {page}, turned {degrees} degrees clockwise',
  'pdf.pages.did.start': 'Opened.',
  'pdf.pages.did.left': { one: 'Turned {count} page left.', other: 'Turned {count} pages left.' },
  'pdf.pages.did.right': {
    one: 'Turned {count} page right.',
    other: 'Turned {count} pages right.',
  },
  'pdf.pages.did.deleted': { one: 'Deleted {count} page.', other: 'Deleted {count} pages.' },
  'pdf.pages.did.earlier': {
    one: 'Moved {count} page one place earlier.',
    other: 'Moved {count} pages one place earlier.',
  },
  'pdf.pages.did.later': {
    one: 'Moved {count} page one place later.',
    other: 'Moved {count} pages one place later.',
  },
  'pdf.pages.did.toStart': {
    one: 'Moved {count} page to the start.',
    other: 'Moved {count} pages to the start.',
  },
  'pdf.pages.did.toEnd': {
    one: 'Moved {count} page to the end.',
    other: 'Moved {count} pages to the end.',
  },
  'pdf.pages.did.movedTo': {
    one: 'Moved {count} page to position {position}.',
    other: 'Moved {count} pages to position {position}.',
  },
  'pdf.pages.save': 'Save PDF',
  'pdf.pages.saving': 'Saving…',
  'pdf.pages.saved': 'Saved: {pages} pages, {size}.',
  'pdf.pages.cancelled': 'Saving cancelled.',
  'pdf.thumbs.failed': 'Some page pictures could not be drawn. The pages themselves are fine.',
} as const satisfies Readonly<Record<string, Message>>;

export type MessageKey = keyof typeof en;
