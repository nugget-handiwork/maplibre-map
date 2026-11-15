import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

// MapLibre runs its tile parsing in a module worker, and resolves that
// worker as new URL('./maplibre-gl-worker.mjs', import.meta.url) — a path
// beside the entry chunk. Nothing statically imports it, so the bundler
// never emits it and the map loads a 404 instead. The worker in turn
// imports ./maplibre-gl-shared.mjs, so the two must land together and
// unhashed for that sibling import to resolve. Nothing is lost by not
// hashing them: an artifact is served from a path carrying its git sha, so
// every file in a revision already has a URL unique to that revision.
//
// Both are emitted into assetsDir for MapLibre's own resolution to find
// them, which is why assetsDir is pinned below rather than left to default.
// The shared module is externalised there too, so the main thread imports
// the same file the worker does instead of carrying its own bundled copy —
// worth about 430KB, since it is nearly half of MapLibre.
const SHARED_MODULE = 'maplibre-gl-shared.mjs'

function maplibreWorker(): Plugin {
  const files = ['maplibre-gl-worker.mjs', SHARED_MODULE]
  return {
    name: 'maplibre-worker',
    async buildStart() {
      for (const name of files) {
        this.emitFile({
          type: 'asset',
          fileName: `assets/${name}`,
          source: await readFile(
            fileURLToPath(import.meta.resolve(`maplibre-gl/dist/${name}`)),
          ),
        })
      }
    },
  }
}

// base './' keeps every asset URL relative: the artifact is served under
// /artifact/<id>/version/<git-sha>/ and must resolve its files there.
export default defineConfig({
  base: './',
  build: {
    assetsDir: 'assets',
    rollupOptions: {
      // Rollup does not copy an external file — the plugin above is what
      // puts it in the output — and it rewrites the specifier relative to
      // the importing chunk. So the path here is stated from the output
      // root, which is what makes it come out as a sibling import.
      external: [new RegExp(`${SHARED_MODULE}$`)],
      output: {
        paths: (id: string) =>
          id.endsWith(SHARED_MODULE) ? `assets/${SHARED_MODULE}` : id,
      },
    },
  },
  plugins: [maplibreWorker()],
})
