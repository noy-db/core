/**
 * `noydb monitor <config.ts>` — live text dashboard of store metrics.
 *
 * Loads a `NoydbOptions` from a config file whose `store` is ALREADY metered,
 * creates a `Noydb` instance so traffic flows through it, and prints a
 * refreshing snapshot to stdout at a configurable interval. Ctrl-C to stop.
 *
 * ⛔ **This command does NOT wrap the store, and must not depend on
 * `@noy-db/to-meter` in any form** (family#100). to-meter is moving to
 * `noy-db/to`, and core publishes BEFORE its satellites — so a dependency
 * here is a publish-order back-edge. ⚠️ An `import type` does not buy an
 * exemption: what makes the back-edge is the MANIFEST entry the type needs,
 * and `workspace:*` stops resolving the moment the package leaves this
 * workspace, which breaks `pnpm install` for the whole monorepo. The types
 * below are therefore declared locally and structurally. **Do not
 * "simplify" them back into an import.**
 *
 * ⭐ The caller wraps instead — `store: toMeter(inner, { degradedMs: 500 })`
 * in the config file, which is also where `onDegraded` / `onRestored` now
 * live. That also makes the config honest: this command used to swap the
 * store out from under it and then report on a store the config never
 * described.
 *
 * This is intentionally CLI-first. A web dashboard is deferred: the
 * meter handle already exposes everything a dashboard needs via
 * `snapshot()` + `subscribe()`.
 *
 * @module
 */
import { loadOptionsFromFile } from './config.js'

/**
 * One method's timings. Names only the fields this formatter READS; the index
 * signature carries the rest a real snapshot reports (`p90` today).
 *
 * ⭐ Open on purpose. Mirroring to-meter's exact field list would make this a
 * structural twin that drifts the moment to-meter adds a percentile — and
 * drift is the cost the local declaration exists to avoid, not one to
 * re-import.
 */
interface MeterMethodStats {
  readonly count: number
  readonly errors: number
  readonly p50: number
  readonly p99: number
  readonly max: number
  readonly avg: number
  readonly [stat: string]: number
}

/**
 * The six core store methods are always present. A real snapshot carries more
 * — `p90`, plus the optional half of the store contract (`listPage`, `tx`, …)
 * — and the index signature is what lets it satisfy this view; the NAMED
 * members are what keep `byMethod[m]` safe under `noUncheckedIndexedAccess`.
 *
 * ⚠️ That a real snapshot populates EVERY key is to-meter's invariant, not
 * ours, and it is witnessed there (`__tests__/meter-composition.test.ts`).
 * This view deliberately cannot assert it.
 */
interface MeterByMethod {
  readonly get: MeterMethodStats
  readonly put: MeterMethodStats
  readonly delete: MeterMethodStats
  readonly list: MeterMethodStats
  readonly loadAll: MeterMethodStats
  readonly saveAll: MeterMethodStats
  readonly [method: string]: MeterMethodStats
}

/** The slice of to-meter's `MeterSnapshot` this formatter reads. */
export interface MeterSnapshotView {
  readonly collectedAt: string
  readonly status: string
  readonly totalCalls: number
  readonly casConflicts: number
  readonly windowMs: number
  readonly byMethod: MeterByMethod
}

/** The slice of to-meter's meter handle this command drives. */
interface MeterHandleView {
  snapshot(): MeterSnapshotView
  close(): void
}

export interface MonitorOptions {
  intervalMs: number
  iterations?: number    // undefined → run forever
}

export async function runMonitor(argv: readonly string[]): Promise<number> {
  const file = argv[0]
  if (!file) {
    process.stderr.write('usage: noydb monitor <config.ts> [--interval=ms]\n')
    return 2
  }

  const intervalArg = argv.find((a) => a.startsWith('--interval='))
  const intervalMs = intervalArg ? parseInt(intervalArg.split('=')[1] ?? '5000', 10) : 5_000

  let opts: Record<string, unknown>
  try {
    const loaded = await loadOptionsFromFile(file)
    if (typeof loaded !== 'object' || loaded === null) {
      process.stderr.write(`config file must export a NoydbOptions-shaped object\n`)
      return 1
    }
    opts = loaded as Record<string, unknown>
  } catch (err) {
    process.stderr.write(`failed to load ${file}: ${(err as Error).message}\n`)
    return 1
  }

  const innerStore = opts['store']
  if (!innerStore || typeof innerStore !== 'object') {
    process.stderr.write('config has no `store` — nothing to monitor\n')
    return 1
  }

  // #845 — toMeter returns the store itself with the handle attached, so a
  // metered config store carries `.meter`. family#100 — the caller wraps.
  const meter = (innerStore as { meter?: MeterHandleView }).meter
  if (!meter || typeof meter.snapshot !== 'function') {
    process.stderr.write(
      'config `store` carries no meter handle — wrap it in the config file:\n' +
      "  import { toMeter } from '@noy-db/to-meter'\n" +
      '  export default { store: toMeter(inner, { degradedMs: 500 }), ... }\n' +
      'onDegraded / onRestored belong there too.\n',
    )
    return 1
  }

  // Dynamically import hub so the CLI doesn't need to bundle it at
  // build time. Adopter's installed @noy-db/hub version wins.
  const hub = await import('@noy-db/hub') as { createNoydb: (o: unknown) => Promise<unknown> }
  await hub.createNoydb(opts)

  process.stdout.write(`monitoring ${file} — interval ${intervalMs}ms — Ctrl-C to stop\n\n`)

  const stop = installSigintHandler(meter)

  return new Promise<number>((resolveP) => {
    const timer = setInterval(() => {
      if (stop.signalled) {
        clearInterval(timer)
        meter.close()
        resolveP(0)
        return
      }
      const snap = meter.snapshot()
      process.stdout.write(formatSnapshot(snap) + '\n')
    }, intervalMs)
  })
}

function installSigintHandler(meter: { close(): void }): { signalled: boolean } {
  const state = { signalled: false }
  const handler = () => { state.signalled = true; meter.close() }
  process.on('SIGINT', handler)
  process.on('SIGTERM', handler)
  return state
}

export function formatSnapshot(snap: MeterSnapshotView): string {
  const lines: string[] = []
  const ts = new Date(snap.collectedAt).toISOString().slice(11, 19)
  lines.push(`[${ts}] status=${snap.status} calls=${snap.totalCalls} casConflicts=${snap.casConflicts} windowMs=${snap.windowMs}`)
  for (const m of ['get', 'put', 'delete', 'list', 'loadAll', 'saveAll'] as const) {
    const s = snap.byMethod[m]
    if (s.count === 0) continue
    lines.push(`  ${m.padEnd(7)} count=${s.count} errors=${s.errors} p50=${s.p50}ms p99=${s.p99}ms max=${s.max}ms avg=${s.avg}ms`)
  }
  return lines.join('\n')
}
