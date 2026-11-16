import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import Card from '../src/ui/Card.svelte';
import TabLinks from '../src/ui/TabLinks.svelte';
import Tile from '../src/ui/Tile.svelte';
import TileGrid from '../src/ui/TileGrid.svelte';
import type { TabItem, TabLink } from '../src/ui/types.ts';
import { textSnippet } from './helpers.ts';
import Tabs from './TabsHost.svelte';

const tabs: readonly TabItem[] = [
  { id: 'json', label: 'JSON' },
  { id: 'yaml', label: 'YAML' },
  { id: 'xml', label: 'XML' },
];

function selectedTab(): string | null {
  return (
    screen.getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true')
      ?.textContent ?? null
  );
}

describe('Tabs', () => {
  it('renders a tablist with the first tab selected by default', () => {
    render(Tabs, { tabs, label: 'Formats' });
    expect(screen.getByRole('tablist', { name: 'Formats' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent.trim())).toEqual([
      'JSON',
      'YAML',
      'XML',
    ]);
    expect(selectedTab()?.trim()).toBe('JSON');
  });

  it('shows only the panel of the selected tab, wired to its tab', () => {
    render(Tabs, { tabs, label: 'Formats', selected: 'yaml' });
    const panel = screen.getByRole('tabpanel');
    expect(panel.textContent).toBe('panel: YAML');
    const tab = screen.getByRole('tab', { name: 'YAML' });
    expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
    expect(tab.getAttribute('aria-controls')).toBe(panel.id);
    expect(screen.queryByText('panel: JSON')).toBeNull();
  });

  it('falls back to the first tab for an unknown selection', () => {
    render(Tabs, { tabs, label: 'Formats', selected: 'nope' });
    expect(screen.getByRole('tabpanel').textContent).toBe('panel: JSON');
  });

  it('only the selected tab is in the tab order (roving tabindex)', () => {
    render(Tabs, { tabs, label: 'Formats', selected: 'yaml' });
    expect(screen.getAllByRole('tab').map((tab) => tab.getAttribute('tabindex'))).toEqual([
      '-1',
      '0',
      '-1',
    ]);
  });

  it('selects a tab by click', async () => {
    const user = userEvent.setup();
    render(Tabs, { tabs, label: 'Formats' });
    expect(screen.getByTestId('bound').textContent).toBe('unset');
    await user.click(screen.getByRole('tab', { name: 'XML' }));
    expect(selectedTab()?.trim()).toBe('XML');
    expect(screen.getByRole('tabpanel').textContent).toBe('panel: XML');
    expect(screen.getByTestId('bound').textContent).toBe('xml');
  });

  it('moves with the arrow keys, wrapping at both ends, and focuses the new tab', async () => {
    const user = userEvent.setup();
    render(Tabs, { tabs, label: 'Formats' });
    await user.tab();
    expect(document.activeElement?.textContent.trim()).toBe('JSON');

    await user.keyboard('{ArrowRight}');
    expect(selectedTab()?.trim()).toBe('YAML');
    expect(document.activeElement?.textContent.trim()).toBe('YAML');

    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(selectedTab()?.trim()).toBe('JSON');

    await user.keyboard('{ArrowLeft}');
    expect(selectedTab()?.trim()).toBe('XML');
    await user.keyboard('{ArrowLeft}');
    expect(selectedTab()?.trim()).toBe('YAML');
  });

  it('jumps with Home and End and ignores other keys', async () => {
    const user = userEvent.setup();
    render(Tabs, { tabs, label: 'Formats', selected: 'yaml' });
    await user.tab();
    await user.keyboard('{End}');
    expect(selectedTab()?.trim()).toBe('XML');
    await user.keyboard('{Home}');
    expect(selectedTab()?.trim()).toBe('JSON');
    await user.keyboard('a');
    expect(selectedTab()?.trim()).toBe('JSON');
  });

  it('renders nothing but the empty tablist for no tabs, and ignores keys', async () => {
    const user = userEvent.setup();
    render(Tabs, { tabs: [], label: 'Empty' });
    expect(screen.getByRole('tablist').children).toHaveLength(0);
    expect(screen.queryByRole('tabpanel')).toBeNull();
    await user.keyboard('{ArrowRight}');
    expect(screen.queryByRole('tabpanel')).toBeNull();
  });

  it('makes the panel focusable so keyboard users can reach scrolling content', () => {
    render(Tabs, { tabs, label: 'Formats' });
    expect(screen.getByRole('tabpanel').getAttribute('tabindex')).toBe('0');
  });
});

describe('TabLinks', () => {
  const links: readonly TabLink[] = [
    { href: '#convert', label: 'Convert', current: true },
    { href: '#base64', label: 'Base64' },
    { href: '#units', label: 'Units', current: false },
  ];

  it('renders a navigation landmark with links', () => {
    render(TabLinks, { links, label: 'Convert tools' });
    const nav = screen.getByRole('navigation', { name: 'Convert tools' });
    expect(nav.querySelectorAll('a')).toHaveLength(3);
    expect(screen.getByRole('link', { name: 'Base64' }).getAttribute('href')).toBe('#base64');
  });

  it('marks only the current page with aria-current', () => {
    render(TabLinks, { links, label: 'Convert tools' });
    expect(screen.getByRole('link', { name: 'Convert' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Base64' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('link', { name: 'Units' }).getAttribute('aria-current')).toBeNull();
  });
});

describe('Card', () => {
  it('is a div by default and keeps its content', () => {
    render(Card, { children: textSnippet('Hello'), 'data-testid': 'card' });
    const card = screen.getByTestId('card');
    expect(card.tagName).toBe('DIV');
    expect(card.textContent).toBe('Hello');
  });

  it.each(['section', 'article', 'li'] as const)('can render as %s', (tag) => {
    render(Card, { tag, children: textSnippet('x'), 'data-testid': 'card' });
    expect(screen.getByTestId('card').tagName).toBe(tag.toUpperCase());
  });

  it('passes aria attributes through', () => {
    render(Card, { tag: 'section', 'aria-label': 'Storage', children: textSnippet('x') });
    expect(screen.getByRole('region', { name: 'Storage' })).toBeTruthy();
  });
});

describe('Tile and TileGrid', () => {
  it('a tile without href is a plain cell', () => {
    render(Tile, { children: textSnippet('Plain'), 'data-testid': 'tile' });
    const tile = screen.getByTestId('tile');
    expect(tile.tagName).toBe('DIV');
    expect(tile.textContent).toBe('Plain');
  });

  it('a tile with href is a link around the whole cell', () => {
    render(Tile, { href: '/pdf', children: textSnippet('PDF') });
    const link = screen.getByRole('link', { name: 'PDF' });
    expect(link.getAttribute('href')).toBe('/pdf');
  });

  it('the grid wraps its tiles and passes attributes through', () => {
    render(TileGrid, { 'aria-label': 'Tools', role: 'group', children: textSnippet('inside') });
    const grid = screen.getByRole('group', { name: 'Tools' });
    expect(grid.textContent).toBe('inside');
  });
});
