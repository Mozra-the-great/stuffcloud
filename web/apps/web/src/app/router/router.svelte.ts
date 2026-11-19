import type { Component } from 'svelte';
import { closestLink, isInternalNavigation } from './links.ts';
import { matchPath, normalisePath, type RouteParams } from './match.ts';

/** Props every routed page receives. A page may declare fewer; it must render one `<h1>`. */
export interface RouteProps {
  readonly params: RouteParams;
  readonly query: URLSearchParams;
}

export type RouteComponent = Component<RouteProps>;

/** A page declares the props it uses; one that uses none is fine, the router passes them anyway. */
export type PageComponent = RouteComponent | Component<Record<string, never>>;

export interface RouteModule {
  readonly default: PageComponent;
}

/** A route: `load` is a dynamic import, so each page (and each tool) is its own chunk. */
export interface RouteDefinition {
  readonly id: string;
  /** Literal segments and `:name` parameters, for example `/tools/:id`. */
  readonly path: string;
  readonly load: () => Promise<RouteModule>;
}

export interface ResolvedRoute {
  readonly route: RouteDefinition;
  readonly params: RouteParams;
  readonly query: URLSearchParams;
  /** Normalised pathname the route was resolved for. */
  readonly path: string;
  /** `false` when the path matched no route and `route` is the not-found page. */
  readonly found: boolean;
}

export interface RouterOptions {
  readonly routes: readonly RouteDefinition[];
  /** Shown for every path that matches no route. */
  readonly notFound: RouteDefinition;
  readonly window?: Window;
  /** Leaves the app (other origin). Defaults to `window.location.assign`. */
  readonly leave?: (url: string) => void;
}

export function resolveRoute(
  routes: readonly RouteDefinition[],
  notFound: RouteDefinition,
  pathname: string,
  search: string,
): ResolvedRoute {
  const query = new URLSearchParams(search);
  const path = normalisePath(pathname);
  for (const route of routes) {
    const params = matchPath(route.path, pathname);
    if (params !== undefined) {
      return { route, params, query, path, found: true };
    }
  }
  return { route: notFound, params: {}, query, path, found: false };
}

/**
 * History-API router for the static single-page build (path URLs, so deep links need the
 * web server's index fallback; see ADR 0011). `current` is reactive. Link clicks inside the
 * app are intercepted once, here, so every component can use a plain `<a href>`.
 */
export class Router {
  readonly #routes: readonly RouteDefinition[];
  readonly #notFound: RouteDefinition;
  readonly #window: Window;
  readonly #leave: (url: string) => void;
  #location = $state({ path: '/', search: '' });
  readonly #current = $derived.by(() =>
    resolveRoute(this.#routes, this.#notFound, this.#location.path, this.#location.search),
  );

  constructor(options: RouterOptions) {
    this.#routes = options.routes;
    this.#notFound = options.notFound;
    this.#window = options.window ?? window;
    this.#leave =
      options.leave ??
      ((url: string): void => {
        this.#window.location.assign(url);
      });
    this.#readLocation();
  }

  get current(): ResolvedRoute {
    return this.#current;
  }

  /** Goes to a same-origin URL (path, query; a fragment is kept in the address bar only). */
  navigate(to: string, options: { readonly replace?: boolean } = {}): void {
    const location = this.#window.location;
    const url = new URL(to, location.href);
    if (url.origin !== location.origin) {
      this.#leave(url.href);
      return;
    }
    if (url.pathname === location.pathname && url.search === location.search) {
      return;
    }
    const target = `${url.pathname}${url.search}${url.hash}`;
    if (options.replace === true) {
      this.#window.history.replaceState(null, '', target);
    } else {
      this.#window.history.pushState(null, '', target);
    }
    this.#readLocation();
  }

  /** Starts listening for link clicks and back/forward; returns the function that stops it. */
  start(): () => void {
    const doc = this.#window.document;
    const onClick = (event: MouseEvent): void => {
      const anchor = closestLink(event.target);
      if (anchor === undefined || !isInternalNavigation(event, anchor, this.#window.location)) {
        return;
      }
      event.preventDefault();
      this.navigate(anchor.href);
    };
    const onPopState = (): void => {
      this.#readLocation();
    };
    doc.addEventListener('click', onClick);
    this.#window.addEventListener('popstate', onPopState);
    return (): void => {
      doc.removeEventListener('click', onClick);
      this.#window.removeEventListener('popstate', onPopState);
    };
  }

  #readLocation(): void {
    const { pathname, search } = this.#window.location;
    this.#location = { path: pathname, search };
  }
}
