#!/usr/bin/env node
/**
 * Gate S8 — real Tint validation of every WGSL chunk, headlessly.
 *
 * WebGPU is unavailable (or software-backed) in most headless contexts, and we
 * cannot rely on a browser to tell us a shader is malformed. Dawn's Node
 * bindings give us the actual compiler Chrome uses, so a typo in a compute
 * shader fails in ~2 seconds at the terminal instead of as a blank canvas.
 *
 * Only shaders/common and shaders/compute are checked. shaders/render is
 * written in Babylon's preprocessed dialect (`varying x : T;`, `uniforms.x`,
 * no @group/@binding) which is NOT valid standalone WGSL — that is precisely
 * why all real logic is kept out of it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create } from 'webgpu';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHADERS = join(HERE, '..', '..', 'src', 'shaders');
const CHECKED = ['common', 'compute'];
const INCLUDE_RE = /^[ \t]*\/\/!include[ \t]+(\S+)[ \t]*$/gm;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.wgsl')) out.push(p);
  }
  return out;
}

/** Mirrors src/engine/wgsl.ts resolveWgsl — two loaders, one rule. */
function resolve(rel, seen = new Set()) {
  const src = readFileSync(join(SHADERS, rel), 'utf8');
  const out = [];
  let last = 0;
  INCLUDE_RE.lastIndex = 0;
  for (let m = INCLUDE_RE.exec(src); m !== null; m = INCLUDE_RE.exec(src)) {
    out.push(src.slice(last, m.index));
    const dep = m[1];
    if (!seen.has(dep)) {
      seen.add(dep);
      out.push(resolve(dep, seen));
      out.push('\n');
    }
    last = m.index + m[0].length;
  }
  out.push(src.slice(last));
  return out.join('');
}

const gpu = create([]);
const adapter = await gpu.requestAdapter();
if (!adapter) {
  console.error('FAIL: no WebGPU adapter available to Dawn.');
  process.exit(2);
}
const device = await adapter.requestDevice();

// Swallow Dawn's own uncaptured-error channel; getCompilationInfo is the
// signal we act on, and a compile error would otherwise print twice.
device.addEventListener?.('uncapturederror', () => {});

const files = CHECKED.flatMap((d) => walk(join(SHADERS, d)));
let failures = 0;
let checked = 0;

for (const abs of files) {
  const rel = relative(SHADERS, abs).replace(/\\/g, '/');
  const code = resolve(rel);

  device.pushErrorScope('validation');
  const mod = device.createShaderModule({ code, label: rel });
  const info = await mod.getCompilationInfo();
  await device.popErrorScope();

  const errors = info.messages.filter((m) => m.type === 'error');
  const warnings = info.messages.filter((m) => m.type === 'warning');
  checked++;

  if (errors.length) {
    failures++;
    console.error(`\x1b[31m✗\x1b[0m ${rel}`);
    for (const m of errors) {
      console.error(`    ${m.lineNum}:${m.linePos}  ${m.message}`);
    }
  } else if (warnings.length) {
    console.log(`\x1b[33m!\x1b[0m ${rel}  (${warnings.length} warning(s))`);
    for (const m of warnings) {
      console.log(`    ${m.lineNum}:${m.linePos}  ${m.message}`);
    }
  } else {
    console.log(`\x1b[32m✓\x1b[0m ${rel}`);
  }
}

console.log(
  `\n${checked} shader(s) checked, ${failures} failed  ` +
    `[adapter: ${adapter.info?.description || adapter.info?.vendor || 'unknown'}]`
);
process.exit(failures > 0 ? 1 : 0);
