/**
 * The XML namespace of SVG. A standalone SVG file (a download, a `data:` image) must carry it as
 * `xmlns`; it names the format and is never requested. It lives here and not in a tool because the
 * source scan of the tools (`tests/tool-rules.test.ts`) rejects every absolute URL, and that rule
 * stays as strict as it is.
 */
export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
