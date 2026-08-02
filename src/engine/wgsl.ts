/**
 * Minimal `//!include <path>` resolver for WGSL sources.
 *
 * The directive is a *comment*, deliberately: an unresolved chunk stays valid
 * WGSL, so every file under shaders/common and shaders/compute can be handed
 * to Tint as-is by tests/node/wgsl_validate.mjs. Babylon's own
 * `#include<name>` mechanism is left alone for the render dialect, which the
 * validator skips anyway.
 *
 * The Node validator implements the same rule against the filesystem
 * (tests/node/wgsl_validate.mjs). Two loaders, one rule — keep them in step.
 */

const INCLUDE_RE = /^[ \t]*\/\/!include[ \t]+(\S+)[ \t]*$/gm;

const modules = import.meta.glob('../shaders/**/*.wgsl', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Keyed by path relative to src/shaders, e.g. "common/sdf.wgsl". */
const sources = new Map<string, string>();
for (const [key, src] of Object.entries(modules)) {
  const rel = key.replace(/^.*?shaders\//, '');
  sources.set(rel, src);
}

export function wgslSource(rel: string): string {
  const src = sources.get(rel);
  if (src === undefined) {
    throw new Error(
      `WGSL source not found: ${rel} (have: ${[...sources.keys()].join(', ')})`
    );
  }
  return src;
}

/**
 * Resolve includes depth-first. Each chunk is emitted at most once, so a
 * diamond include (two chunks both pulling in common/sdf.wgsl) does not
 * produce duplicate function definitions.
 */
export function resolveWgsl(rel: string, seen = new Set<string>()): string {
  const src = wgslSource(rel);
  const out: string[] = [];
  let last = 0;

  INCLUDE_RE.lastIndex = 0;
  for (let m = INCLUDE_RE.exec(src); m !== null; m = INCLUDE_RE.exec(src)) {
    out.push(src.slice(last, m.index));
    const dep = m[1];
    if (!seen.has(dep)) {
      seen.add(dep);
      out.push(resolveWgsl(dep, seen));
      out.push('\n');
    }
    last = m.index + m[0].length;
  }
  out.push(src.slice(last));
  return out.join('');
}
