import { defineConfig, type Plugin } from 'vite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Read the version from package.json rather than duplicating it, so the
// published version and the one stamped into exports cannot drift apart.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/**
 * Dev-only screenshot sink.
 *
 * The agent browser pane cannot composite frames, so `computer{screenshot}`
 * times out and there is no way to eyeball a render. This lets the page POST a
 * PNG straight to disk, which both the agent and a human can then open. It is
 * also the mechanism the Phase 2+ golden-image regression tests will use.
 *
 * Dev server only — never part of a production build.
 */
function screenshotSink(): Plugin {
  return {
    name: 'corticum-screenshot-sink',
    apply: 'serve',
    configureServer(server) {
      // Generic data sink: the browser POSTs verification results here so a
      // Python reference can score them against the source NIfTI. Keeps the
      // GPU-side measurement and the ground-truth comparison in separate
      // processes, which is the point — a self-check that shares code with the
      // thing it checks proves very little.
      server.middlewares.use('/__data', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          return res.end('POST only');
        }
        const name = String(req.headers['x-data-name'] || 'data').replace(/[^\w.-]/g, '_');
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const out = resolve(server.config.root, 'tests/artifacts', `${name}.json`);
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, Buffer.concat(chunks));
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, path: out }));
        });
      });

      server.middlewares.use('/__shot', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          return res.end('POST only');
        }
        const name = String(req.headers['x-shot-name'] || 'frame').replace(/[^\w.-]/g, '_');
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const b64 = Buffer.concat(chunks).toString('utf8').replace(/^data:image\/\w+;base64,/, '');
          const out = resolve(server.config.root, 'tests/artifacts', `${name}.png`);
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, Buffer.from(b64, 'base64'));
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, path: out }));
        });
      });
    },
  };
}

// base: './' (relative, not '/corticum/') + hash routing, so a build is servable
// from any subpath — GitHub Pages project sites, a local `vite preview`, or a
// file:// spot-check all work from the same dist/.
export default defineConfig({
  plugins: [screenshotSink()],
  base: './',
  define: {
    // Build stamp: lets us spot a stale cached bundle instantly when debugging
    // a GPU issue that "should already be fixed".
    __BUILD__: JSON.stringify(new Date().toISOString()),
    // Semantic version, read from package.json so the two cannot drift. Stamped
    // into every export's provenance sidecar — a result produced by this tool
    // has to name the version that produced it or it cannot be cited.
    __VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    // Exposed on the LAN so the page can be opened in a real browser on the
    // GPU box rather than only in a headless/agent pane.
    host: true,
    port: 5173,
  },
  assetsInclude: ['**/*.wgsl'],
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 4000,
  },
});
