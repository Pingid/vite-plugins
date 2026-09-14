var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { bundler } from './build.js';
import { toNode } from './node.js';
/**
 * Mounts a backend app inside the vite dev and preview servers.
 *
 * The app is loaded through vite's SSR pipeline, so it gets the same transforms
 * and resolution as the rest of the project and picks up edits with no restart.
 */
export const serve = (mounts, options = {}) => {
    const list = Object.entries(mounts).map(([at, input]) => {
        const it = typeof input === 'string' ? { file: input } : input;
        if (!at.startsWith('/'))
            throw new Error(`[pingid:server] mount path ${JSON.stringify(at)} must start with "/"`);
        // Only for a `build` set on the mount itself. A shared one reaches every
        // mount, and the ones with nowhere to write are meant to be left alone.
        if (it.build && !it.preview)
            throw new Error(`[pingid:server] mount ${JSON.stringify(at)} sets \`build\` but no \`preview\` — ` +
                '`build` writes the entry `preview` reads');
        return { ...options, ...it, at: at === '/' ? '/' : at.replace(/\/+$/, '') };
    });
    let config;
    /**
     * Sequential on purpose: a handful of entries at most, and interleaved
     * bundler output is worse than the wait. The first failure stops the rest.
     */
    const produce = async (when) => {
        const done = pass(config.root);
        for (const m of list) {
            if (!m.build || !m.preview || (m.buildOrder ?? 'post') !== when)
                continue;
            const file = path.resolve(config.root, m.file);
            const out = path.resolve(config.root, m.preview);
            // Built already in this pass — unless the output has since gone, which is
            // what a later environment emptying a shared `outDir` does to it.
            const key = `${when} ${m.at}`;
            if (done.has(key) && fs.existsSync(out))
                continue;
            done.add(key);
            const started = Date.now();
            const build = bundler(config, file, out, (files) => watched.set(`${config.root} ${m.at}`, files));
            try {
                await m.build({ at: m.at, file, out, build, mount: m, config });
            }
            catch (error) {
                throw new Error(format(m, error));
            }
            const took = Date.now() - started;
            // Rollup says nothing about a file it didn't emit, so say it here.
            config.logger.info(`[pingid:server] built ${m.at} → ${path.relative(config.root, out)} in ${took}ms`);
        }
    };
    /**
     * Deliberately not cached. Re-importing is what picks up an edit, and it is
     * cheap when nothing changed: vite's watcher nulls `transformResult` only for
     * what actually changed, and the runner re-evaluates only those modules. So a
     * module's top-level state — a pool, a cache — survives across requests.
     */
    const dev = (server, m) => {
        const file = path.resolve(config.root, m.file);
        if (m.fresh)
            evict(server, file);
        const runner = runnerOf(server);
        // Prefer the runner: in vite 6+ `ssrLoadModule` throws outright if a
        // framework swapped the ssr environment for a non-runnable one.
        return runner ? runner.import(file) : server.ssrLoadModule(file);
    };
    const built = new Map();
    const preview = (m) => {
        const file = path.resolve(config.root, m.preview);
        const href = pathToFileURL(file).href;
        // Node's ESM registry can't be cleared, so a fresh instance means a URL it
        // hasn't seen. Every version stays resident — fine for a local command, and
        // the reason this isn't the default.
        if (m.fresh)
            return import(__rewriteRelativeImportExtension(`${href}?t=${Date.now()}`));
        const found = built.get(file);
        if (found)
            return found;
        const next = import(__rewriteRelativeImportExtension(href));
        built.set(file, next);
        return next;
    };
    const mount = (m, load) => (req, res, next) => {
        const url = route(m, req, config.base);
        if (url === null)
            return next();
        // Connect neither awaits handlers nor catches rejections, so dispatch stays
        // synchronous and every failure is routed by hand.
        void load().then((mod) => {
            const handler = resolve(m, mod);
            if (handler.kind === 'node')
                return handler.run(req, res, next);
            return toNode(handler.run, { url: () => url })(req, res, next);
        }, (error) => fail(config, m, error, req, res, next));
        return;
    };
    const upgrades = (server, on, load) => {
        const wanted = on.filter((m) => m.upgrade);
        // No `httpServer` means middleware mode, where vite runs HMR on a server of
        // its own and the embedding server owns upgrades.
        if (!wanted.length || !server.httpServer)
            return;
        server.httpServer.on('upgrade', (req, socket, head) => {
            // Vite claims an upgrade only for these two subprotocols on its base path,
            // and leaves everything else strictly alone — so mirror that and get out
            // of the way. Never `removeAllListeners('upgrade')`; that kills HMR.
            const protocol = req.headers['sec-websocket-protocol'];
            if (protocol === 'vite-hmr' || protocol === 'vite-ping')
                return;
            const m = wanted.find((it) => route(it, req, config.base) !== null);
            if (!m)
                return;
            void load(m).then((mod) => m.upgrade?.(mod)?.(req, socket, head), 
            // An unclaimed socket is left open rather than destroyed: vite's proxy
            // may also be listening, and only Node's "no listeners at all" case is
            // safe to treat as terminal.
            (error) => config.logger.error(format(m, error)));
        });
    };
    return {
        name: 'pingid:server',
        configResolved: (config_) => void (config = config_),
        // A `function` expression, not an arrow, so `this` is the rollup plugin
        // context — `this.error` is how a plugin fails a build: it throws, names the
        // plugin and stops rollup, rather than leaving a rejection behind.
        buildStart: async function () {
            if (config.command !== 'build')
                return;
            if (this.meta.watchMode) {
                // Every rebuild is a new pass, so nothing carries over from the last one.
                passes.delete(config.root);
                // A server entry is nothing to do with the client graph, so `--watch`
                // would never notice an edit to it. Registering it — and whatever its
                // last bundle read — makes the rebuild fire, which is the point of the flag.
                for (const m of list) {
                    if (!m.build || !m.preview)
                        continue;
                    this.addWatchFile(path.resolve(config.root, m.file));
                    for (const file of watched.get(`${config.root} ${m.at}`) ?? [])
                        this.addWatchFile(file);
                }
            }
            try {
                await produce('pre');
            }
            catch (error) {
                this.error(error instanceof Error ? error.message : String(error));
            }
        },
        // `closeBundle` rather than `writeBundle`, which fires once per output: a
        // config with several `build.rollupOptions.output` entries would otherwise
        // build the server once per output within a single environment.
        closeBundle: async function () {
            if (config.command !== 'build')
                return;
            try {
                await produce('post');
            }
            catch (error) {
                this.error(error instanceof Error ? error.message : String(error));
            }
        },
        configureServer(server) {
            // A `configureServer` body lands ahead of vite's own middlewares, which is
            // what a prefix mount wants — it beats the public dir and `server.proxy`.
            // A `/` catch-all there would swallow `/@vite/client` and kill HMR, so it
            // goes in the post hook instead, after vite has served its own routes.
            const [root, prefixed] = split(list);
            for (const m of prefixed)
                server.middlewares.use(mount(m, () => dev(server, m)));
            upgrades(server, list, (m) => dev(server, m));
            if (!root.length)
                return;
            return () => {
                for (const m of root)
                    server.middlewares.use(mount(m, () => dev(server, m)));
            };
        },
        configurePreviewServer(server) {
            // Nothing is built for us, so a mount can only be served in preview if it
            // was told where its output landed. Say so at startup rather than leaving
            // a route to fail per request.
            for (const m of list.filter((it) => !it.preview))
                config.logger.warn(`[pingid:server] "${m.at}" is not mounted in preview — set \`preview\` to its built server entry`);
            const mountable = list.filter((m) => m.preview);
            const [root, prefixed] = split(mountable);
            for (const m of prefixed)
                server.middlewares.use(mount(m, () => preview(m)));
            upgrades(server, mountable, (m) => preview(m));
            if (!root.length)
                return;
            return () => {
                for (const m of root)
                    server.middlewares.use(mount(m, () => preview(m)));
            };
        },
    };
};
/**
 * What a single `vite build` has already produced, keyed by project root.
 *
 * Vite 6+ builds once per environment and re-resolves the config for each,
 * which re-imports the config file, re-runs `serve` and hands every environment
 * its own plugin instance — so a closure cannot see what a sibling already did.
 * This module is imported once per process, so this can.
 *
 * Not `applyToEnvironment` (absent before vite 6) and not a test for `client`,
 * which would silently skip a build that has no client environment, such as
 * `vite build --ssr`.
 */
const passes = new Map();
const pass = (root) => {
    const found = passes.get(root);
    if (found)
        return found;
    const next = new Set();
    passes.set(root, next);
    return next;
};
/** Per root and mount, every file its last bundle read — the watch list for the next rebuild. */
const watched = new Map();
const split = (list) => [
    list.filter((m) => m.at === '/'),
    list.filter((m) => m.at !== '/'),
];
/**
 * Nulls the transform result for the entry and everything below it, which is
 * what makes the next import re-transform and re-evaluate: the SSR runner
 * discards its evaluated copy of any module vite reports as invalidated.
 *
 * `invalidateModule` already walks *importers* on its own; the recursion here
 * goes the other way, down through `importedModules`.
 *
 * Externalized dependencies are untouched — they never enter this graph, and
 * Node's ESM cache holds them regardless. So `fresh` resets your code, not the
 * whole world.
 */
const evict = (server, file) => {
    const graph = graphOf(server);
    const roots = graph?.getModulesByFile?.(file);
    if (!graph || !roots)
        return;
    const seen = new Set();
    const drop = (mod) => {
        if (seen.has(mod))
            return;
        seen.add(mod);
        graph.invalidateModule(mod);
        for (const dep of mod.importedModules)
            drop(dep);
    };
    for (const root of roots)
        drop(root);
};
const graphOf = (server) => {
    const envs = server
        .environments;
    // per-environment graph in vite 6+, the mixed facade before that
    return envs?.['ssr']?.moduleGraph ?? server.moduleGraph;
};
/**
 * Structural, not `isRunnableDevEnvironment`: that export doesn't exist before
 * vite 6 so a static import would hard-fail there, and it is an `instanceof`
 * check, which breaks across duplicated vite copies in a workspace.
 */
const runnerOf = (server) => {
    const envs = server
        .environments;
    const runner = envs?.['ssr']?.runner;
    return typeof runner?.import === 'function' ? runner : undefined;
};
/**
 * The path to hand the app, or `null` if this mount doesn't claim the request.
 *
 * Reads `originalUrl` because by the time a post-hook middleware runs, `req.url`
 * has been through `baseMiddleware` (base stripped) and possibly
 * `htmlFallbackMiddleware` (rewritten to `/index.html` for an HTML navigation).
 * `originalUrl` is set once at dispatch and survives both.
 */
const route = (m, req, base) => {
    const raw = req.originalUrl ?? req.url ?? '/';
    const q = raw.indexOf('?');
    const search = q === -1 ? '' : raw.slice(q);
    let pathname = q === -1 ? raw : raw.slice(0, q);
    if (base !== '/' && pathname.startsWith(base.slice(0, -1)))
        pathname = pathname.slice(base.length - 1) || '/';
    if (m.at === '/')
        return pathname + search;
    // Path-boundary match, so `/api` never claims `/apifoo`.
    if (pathname !== m.at && !pathname.startsWith(`${m.at}/`))
        return null;
    return (m.strip ? pathname.slice(m.at.length) || '/' : pathname) + search;
};
/**
 * Detection is standards-only — a bare function, or the `{ fetch }` shape
 * Cloudflare, Bun and Deno share. Anything framework-specific (Elysia's
 * `handle`, Express's `handle`) is one line of `handler`, kept out of here so
 * this module carries no library knowledge.
 */
const resolve = (m, mod) => {
    const found = m.handler ? m.handler(mod) : detect(m, mod);
    // Fetch handlers take one argument; Node handlers take `(req, res, next)`.
    const kind = m.kind ?? (found.length >= 2 ? 'node' : 'fetch');
    return kind === 'node' ? { kind, run: found } : { kind, run: found };
};
const detect = (m, mod) => {
    const name = m.export ?? 'default';
    const value = mod?.[name];
    if (typeof value === 'function')
        return value;
    const fetch = value?.fetch;
    if (typeof fetch === 'function')
        return fetch.bind(value);
    throw new Error(`[pingid:server] "${m.file}" has nothing usable on export "${name}" — expected a function, or an object ` +
        `with a \`fetch\` method. For anything else pass \`handler\`, e.g. \`handler: (m) => (r) => m.default.handle(r)\``);
};
const fail = (config, m, error, req, res, next) => {
    if (m.onError)
        return m.onError(error, req, res, next);
    config.logger.error(format(m, error));
    if (res.headersSent)
        return res.destroy(error instanceof Error ? error : new Error(String(error)));
    // Not `next(error)`: vite's error middleware answers with an HTML overlay
    // page, which is the wrong reply to an API client. `onError` opts into it.
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(format(m, error));
};
const format = (m, error) => {
    const e = error instanceof Error ? error : new Error(String(error));
    return `[pingid:server] ${m.at} — ${e.stack ?? e.message}`;
};
//# sourceMappingURL=plugin.js.map