import type { Plugin, ResolvedConfig } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { type Build } from './build.ts';
import { type Fetch, type Node } from './node.ts';
export type Mounts = Record<string, string | Mount>;
/** A loaded module. Only the caller knows its shape, hence `any`. */
export type Loaded = any;
/** Handles a websocket upgrade. Return truthy to claim the socket. */
export type Upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean | void;
/** What a mount's `build` is handed during `vite build`. */
export interface Building {
    /** Mount path, e.g. `/api`. */
    at: string;
    /** The entry to build — `file` resolved against vite root, absolute. */
    file: string;
    /** Where it goes — `preview` resolved against vite root, absolute. */
    out: string;
    /** esbuild, already configured for a node ESM bundle of `file` into `out`. Anything passed wins. */
    build: Build;
    /** The mount as configured, with the shared options merged in. */
    mount: Mount;
    config: ResolvedConfig;
}
/** Builds one mount's server entry during `vite build`. Rejecting fails the build. */
export type BuildHook = (cx: Building) => void | Promise<void>;
export interface Mount {
    file: string;
    /** Named export carrying the app. Default `default`. */
    export?: string;
    /** Pull the handler off the loaded module yourself; skips detection entirely. */
    handler?: (mod: Loaded) => Fetch | Node;
    /** Force the handler shape when arity detection guesses wrong. */
    kind?: 'fetch' | 'node';
    /** Drop the mount path before handing the request over. Default `false`. */
    strip?: boolean;
    /**
     * Discard the entry and everything it imports before every request, so no
     * module is ever reused. Default `false`.
     *
     * Off, a module is re-evaluated only when it or one of its dependencies
     * changes, so top-level state persists. On, every request re-transforms and
     * re-evaluates from scratch and all state is rebuilt.
     */
    fresh?: boolean;
    /** Built server entry, relative to vite root. Required for `vite preview`. */
    preview?: string;
    /**
     * Produces that entry during `vite build` — usually `(cx) => cx.build()`.
     * Requires `preview`, which is where the output goes. Omit to build it yourself.
     */
    build?: BuildHook;
    /**
     * When it runs: `post` after the client bundle is written, so its output and
     * manifest exist; `pre` before the build starts. Default `post`.
     */
    buildOrder?: 'pre' | 'post';
    /** Pull a websocket upgrade handler off the module. Omit for no upgrade handling. */
    upgrade?: (mod: Loaded) => Upgrade | undefined;
    /** Full control of failures. Default: log and send a 500. */
    onError?: (error: unknown, req: IncomingMessage, res: ServerResponse, next: (e?: unknown) => void) => void;
}
/** Defaults applied to every mount — which is how an integration sets `handler` once. */
export type ServeOptions = Omit<Mount, 'file' | 'preview'>;
/**
 * Mounts a backend app inside the vite dev and preview servers.
 *
 * The app is loaded through vite's SSR pipeline, so it gets the same transforms
 * and resolution as the rest of the project and picks up edits with no restart.
 */
export declare const serve: (mounts: Mounts, options?: ServeOptions) => Plugin;
//# sourceMappingURL=plugin.d.ts.map