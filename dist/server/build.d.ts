import type { ResolvedConfig } from 'vite';
import * as esbuild from 'esbuild';
/**
 * Bundles a mount's entry. The defaults already produce a node ESM build at
 * `out`, so `cx.build()` on its own is a complete integration; anything passed
 * here wins over them.
 */
export type Build = (options?: esbuild.BuildOptions) => Promise<esbuild.BuildResult>;
/** `deps` receives every absolute path esbuild read, which is what `--watch` needs to see. */
export declare const bundler: (config: ResolvedConfig, file: string, out: string, deps?: (files: string[]) => void) => Build;
//# sourceMappingURL=build.d.ts.map