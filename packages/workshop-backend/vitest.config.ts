import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import capnwebValidate from 'capnweb-validate/vite'

// Wrangler ships `*.txt` imports as Text modules (its default module rules; see
// src/text-modules.d.ts), but this config drives the pool from inline miniflare settings, and
// vite's own fallback would resolve them as asset URLs. Mirror the Text-module behavior so code
// under test (e.g. describeBinding's worktree-binding.txt) sees the real content. Like wrangler,
// match on the *import path*: resolving here keeps vite from realpathing the id, which for a
// symlinked .txt (the binding .txts are symlinks to their .d.ts) would dodge the load hook
// below and fall through to the TypeScript pipeline.
const textModules: Plugin = {
  name: 'text-modules',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source.endsWith('.txt') && importer !== undefined) {
      return path.resolve(path.dirname(importer), source)
    }
  },
  load(id) {
    if (id.endsWith('.txt')) {
      return `export default ${JSON.stringify(readFileSync(id, 'utf-8'))};`
    }
  },
}

// Records the agent spans (see src/agent-tracing.ts) this Worker emits, as a streaming tail
// worker receives them, so tests can read them back through the SPAN_RECORDER binding.
const spanRecorder = `
import { WorkerEntrypoint } from "cloudflare:workers";
const AGENT_SPAN = /^(invoke_agent|chat|execute_tool|tool_approval)( |$)/;
const spans = new Map();
export class SpanRecorder extends WorkerEntrypoint {
  spans() { return [...spans.values()]; }
}
export default {
  tailStream() {
    return ({ event, spanContext }) => {
      if (event.type === "spanOpen" && AGENT_SPAN.test(event.name)) {
        spans.set(event.spanId, {
          name: event.name, spanId: event.spanId, parentSpanId: spanContext.spanId,
          attributes: {}, closed: false,
        });
      }
      let span = spans.get(spanContext.spanId);
      if (span === undefined) return;
      if (event.type === "attributes") {
        for (let { name, value } of event.info) span.attributes[name] = value;
      } else if (event.type === "spanClose") {
        span.closed = true;
      }
    };
  },
};
`

/**
 * Tests run inside workerd (via vitest-pool-workers) so they exercise the same runtime APIs as
 * production -- e.g. Uint8Array.toHex/fromHex and crypto.subtle used by the sharing module. Most
 * tests import modules directly; the main Worker and a test-only SQLite DO binding support the
 * Overseer cost-persistence integration test without loading the full deployment configuration.
 */
export default defineConfig({
  plugins: [
    textModules,
    capnwebValidate(),
    cloudflareTest({
      // The production Worker plus test-only entrypoints (see __tests__/test-worker.ts).
      main: './__tests__/test-worker.ts',
      miniflare: {
        compatibilityDate: '2026-09-04',
        // `allow_irrevocable_stub_storage` as in wrangler.jsonc: the user DO persists account stubs.
        compatibilityFlags: ['experimental', 'nodejs_compat', 'allow_irrevocable_stub_storage'],
        streamingTails: ['span-recorder'],
        serviceBindings: { SPAN_RECORDER: { name: 'span-recorder', entrypoint: 'SpanRecorder' } },
        workers: [{
          name: 'span-recorder',
          modules: true,
          script: spanRecorder,
          compatibilityDate: '2026-09-04',
          compatibilityFlags: ['experimental', 'streaming_tail_worker'],
        }],
        bindings: { PUBLIC_BASE_URL: 'https://workshop.example/' },
        // The overseer loads gadget code through this, so a test can run a real gadget facet.
        workerLoaders: { LOADER: {} },
        durableObjects: {
          TEST_OVERSEER: { className: 'OverseerDurableObject', useSQLite: true },
          TEST_USER: { className: 'UserDurableObject', useSQLite: true },
          TEST_PENDING_LOGIN: { className: 'PendingLogin', useSQLite: true },
          // Never addressed by name: a binding is what puts the class in `ctx.exports`, from
          // which the overseer instantiates it (with props) as one of its own facets.
          TEST_AGENT_SPAWNER: { className: 'AgentSpawnerGatekeeper', useSQLite: true },
          TEST_USER_DIRECTORY: { className: 'UserDirectoryDurableObject', useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ['__tests__/*.test.ts'],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ['@gadgets/scripts/assert-workerd'],
  },
})
