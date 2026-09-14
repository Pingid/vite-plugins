import type { ResolvedConfig } from 'vite'
import * as esbuild from 'esbuild'
import path from 'node:path'

/**
 * Bundles a mount's entry. The defaults already produce a node ESM build at
 * `out`, so `cx.build()` on its own is a complete integration; anything passed
 * here wins over them.
 */
export type Build = (options?: esbuild.BuildOptions) => Promise<esbuild.BuildResult>

/**
 * Vite's resolution and env, as far as esbuild can express them, aimed at node.
 *
 * Deliberately not `src/iife/build.ts`'s `opts()`: that one bundles for the
 * browser as an IIFE, keeps its output in memory, minifies on build and freezes
 * `import.meta.env` into the bundle — every one of which is wrong for a server
 * entry that runs under node and reads its environment at runtime.
 */
const opts = (config: ResolvedConfig, file: string, out: string): esbuild.BuildOptions => ({
  entryPoints: [file],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: `node${process.versions.node.split('.')[0] ?? '18'}`,
  // Dependencies stay on disk rather than in the bundle. `vite preview` runs
  // from the project, where node_modules is right there, and a native or
  // self-referencing package is where a server bundle usually breaks.
  packages: 'external',
  sourcemap: true,
  // Only read to report inputs back for watching; esbuild still writes the
  // bundle itself, so this costs a little bookkeeping and nothing else.
  metafile: true,
  absPaths: ['metafile'],
  // Vite owns the console here: warnings go through its logger below, and
  // failures are raised as an error rather than printed twice.
  logLevel: 'silent',
  absWorkingDir: config.root,
  conditions: conditions(config),
  resolveExtensions: config.resolve.extensions,
  alias: aliases(config),
  define: {
    'process.env.NODE_ENV': JSON.stringify(config.isProduction ? 'production' : 'development'),
    ...defines(config.define),
  },
})

/** `deps` receives every absolute path esbuild read, which is what `--watch` needs to see. */
export const bundler = (
  config: ResolvedConfig,
  file: string,
  out: string,
  deps: (files: string[]) => void = () => {},
): Build => {
  const base = opts(config, file, out)

  return async (over: esbuild.BuildOptions = {}) => {
    const res = await esbuild.build(merge(base, over)).catch((e: unknown) => {
      // Unprefixed: this always surfaces through the mount's own `format`,
      // which names the plugin and the mount path already.
      throw new Error(`bundle failed\n${format(e)}`)
    })
    for (const w of res.warnings) config.logger.warn(`[pingid:server] ${w.text}`)
    // `<stdin>` and other synthetic inputs are not absolute, so they drop out here.
    deps(Object.keys(res.metafile?.inputs ?? {}).filter((f) => path.isAbsolute(f)))
    return res
  }
}

const merge = (base: esbuild.BuildOptions, over: esbuild.BuildOptions): esbuild.BuildOptions => {
  const next: esbuild.BuildOptions = {
    ...base,
    ...over,
    alias: { ...base.alias, ...over.alias },
    define: { ...base.define, ...over.define },
  }
  // esbuild refuses `outfile` alongside `outdir`, and a caller supplying its own
  // input means ours is replaced rather than added to.
  if (over.outdir) delete next.outfile
  if (over.stdin) delete next.entryPoints
  return next
}

/**
 * The SSR environment's conditions, which are the ones that describe node —
 * read structurally because they moved: `environments.ssr.resolve` in vite 6+,
 * `ssr.resolve` before that, and neither on very old vite.
 */
const conditions = (config: ResolvedConfig): string[] | undefined => {
  type Resolve = { resolve?: { conditions?: string[] } }
  const envs = (config as unknown as { environments?: Record<string, Resolve | undefined> }).environments
  const ssr = envs?.['ssr']?.resolve?.conditions ?? (config as unknown as { ssr?: Resolve }).ssr?.resolve?.conditions
  return ssr ?? config.resolve.conditions
}

/** esbuild `define` takes replacement source text; vite's config takes values. */
const defines = (define: Record<string, unknown> | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(define ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))

/** Only plain-string `find` aliases can cross over; anything else is reported, not silently dropped. */
const aliases = (config: ResolvedConfig): Record<string, string> => {
  const dropped: string[] = []
  const kept: Record<string, string> = {}
  for (const { find, replacement } of config.resolve.alias) {
    if (typeof find === 'string') kept[find] = replacement
    // Vite's own client aliases are regexes and irrelevant to a server bundle,
    // so reporting them would be pure noise on every build.
    else if (!INTERNAL.test(find.source)) dropped.push(String(find))
  }
  if (dropped.length)
    config.logger.warn(
      `[pingid:server] esbuild cannot honour regex aliases, so these are ignored inside the bundle: ${dropped.join(', ')}`,
    )
  return kept
}

const format = (e: unknown) => {
  const errors = (e as { errors?: esbuild.Message[] }).errors
  if (!errors?.length) return e instanceof Error ? e.message : String(e)
  return errors.map((m) => `  ${m.location ? `${m.location.file}:${m.location.line} ` : ''}${m.text}`).join('\n')
}

const INTERNAL = /@vite/
