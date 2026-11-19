export type RouteParams = Readonly<Record<string, string>>;

/** Pathname without a trailing slash (the root stays `/`). */
export function normalisePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/**
 * Matches `pathname` against a pattern of literal segments and `:name` parameters
 * (`/tools/:id`). Returns the decoded parameters, or `undefined` when it does not match.
 * A parameter is never empty and a malformed escape (`%E0%A4%A`) never matches.
 */
export function matchPath(pattern: string, pathname: string): RouteParams | undefined {
  const wanted = normalisePath(pattern).split('/');
  const actual = normalisePath(pathname).split('/');
  if (wanted.length !== actual.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (const [index, segment] of wanted.entries()) {
    const value = actual[index] ?? '';
    if (segment.startsWith(':')) {
      if (value === '') {
        return undefined;
      }
      try {
        params[segment.slice(1)] = decodeURIComponent(value);
      } catch {
        return undefined;
      }
    } else if (segment !== value) {
      return undefined;
    }
  }
  return params;
}
