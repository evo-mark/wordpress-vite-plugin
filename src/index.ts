import fs from "node:fs";
import wpGlobals from "./wpGlobals.js";
import { fileURLToPath } from "node:url";
import { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import colors from "picocolors";
import {
    Plugin,
    loadEnv,
    UserConfig,
    ConfigEnv,
    ResolvedConfig,
    SSROptions,
    PluginOption,
} from "vite";
import fullReload, {
    Config as FullReloadConfig,
} from "vite-plugin-full-reload";

interface PluginConfig {
    /**
     * The name of the Wordpress plugin or theme
     */
    namespace: string;

    /**
     * The path or paths of the entry points to compile.
     */
    input: string | string[];

    /**
     * Wordpress's public directory.
     *
     * @default 'public'
     */
    publicDirectory?: string;

    /**
     * Build options for Vite
     */
    emptyOutDir?: boolean;

    /**
     * The public subdirectory where compiled assets should be written.
     *
     * @default 'build'
     */
    buildDirectory?: string;

    /**
     * The path to the "hot" file.
     *
     * @default `${publicDirectory}/hot`
     */
    hotFile?: string;

    /**
     * The path of the SSR entry point.
     */
    ssr?: string | string[];

    ssrExternal: boolean;

    /**
     * The directory where the SSR bundle should be written.
     *
     * @default 'bootstrap/ssr'
     */
    ssrOutputDirectory?: string;

    /**
     * Configuration for performing full page refresh on blade (or other) file changes.
     *
     * {@link https://github.com/ElMassimo/vite-plugin-full-reload}
     * @default false
     */
    refresh?: boolean | string | string[] | RefreshConfig | RefreshConfig[];

    /**
     * Transform the code while serving.
     */
    transformOnServe?: (code: string, url: DevServerUrl) => string;
}

interface RefreshConfig {
    paths: string[];
    config?: FullReloadConfig;
}

interface WordpressPlugin extends Plugin {
    config: (config: UserConfig, env: ConfigEnv) => UserConfig;
}

type DevServerUrl = `${"http" | "https"}://${string}:${number}`;

let exitHandlersBound = false;

export const refreshPaths = ["resources/views/**"];

/**
 * Wordpress plugin for Vite.
 *
 * @param config - A config object or relative path(s) of the scripts to be compiled.
 */
export function wordpress(
    config: PluginConfig
): [WordpressPlugin, ...Plugin[]] {
    const pluginConfig = resolvePluginConfig(config);

    if (fs.existsSync(pluginConfig.publicDirectory) === false) {
        fs.mkdirSync(pluginConfig.publicDirectory, { recursive: true });
    }

    const globalsPlugin: Plugin = {
        ...wpGlobals,
        apply: "build",
    };

    return [
        resolveWordpressPlugin(pluginConfig),
        globalsPlugin,
        ...(resolveFullReloadConfig(pluginConfig) as Plugin[]),
    ];
}

/**
 * Resolve the Wordpress Plugin configuration.
 */
function resolveWordpressPlugin(
    pluginConfig: Required<PluginConfig>
): WordpressPlugin {
    let viteDevServerUrl: DevServerUrl;
    let resolvedConfig: ResolvedConfig;
    let userConfig: UserConfig;

    const defaultAliases: Record<string, string> = {
        "@": "/resources/js",
    };

    return {
        name: "wordpress",
        enforce: "post",
        config: (config, { command, mode, isSsrBuild }) => {
            userConfig = config;
            const ssr = !!userConfig.build?.ssr;
            const env = loadEnv(mode, userConfig.envDir || process.cwd(), "");
            const serverConfig =
                command === "serve"
                    ? resolveEnvironmentServerConfig(env)
                    : undefined;

            ensureCommandShouldRunInEnvironment(command, env);

            return {
                base: userConfig.base ?? (command === "build" ? "./" : ""),
                publicDir: userConfig.publicDir ?? false,
                build: {
                    emptyOutDir: pluginConfig.emptyOutDir ?? true,
                    manifest:
                        userConfig.build?.manifest ??
                        (ssr ? false : "manifest.json"),
                    ssrManifest:
                        userConfig.build?.ssrManifest ??
                        (ssr ? "ssr-manifest.json" : false),
                    outDir:
                        userConfig.build?.outDir ??
                        resolveOutDir(pluginConfig, ssr),
                    rollupOptions: {
                        input:
                            userConfig.build?.rollupOptions?.input ??
                            resolveInput(pluginConfig, ssr),
                        output: {
                            entryFileNames: isSsrBuild
                                ? "[name].mjs"
                                : "assets/[name]-[hash].js",
                        },
                    },
                    assetsInlineLimit: userConfig.build?.assetsInlineLimit ?? 0,
                },
                server: {
                    origin:
                        userConfig.server?.origin ??
                        "http://__wordpress_vite_placeholder__.test",
                    ...(serverConfig
                        ? {
                              host:
                                  userConfig.server?.host ?? serverConfig.host,
                              hmr:
                                  userConfig.server?.hmr === false
                                      ? false
                                      : {
                                            ...serverConfig.hmr,
                                            ...(userConfig.server?.hmr === true
                                                ? {}
                                                : userConfig.server?.hmr),
                                        },
                          }
                        : undefined),
                    cors: userConfig.server?.cors ?? {
                        origin: userConfig.server?.origin ?? [
                            /^https?:\/\/(?:(?:[^:]+\.)?localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/,
                            ...(env.APP_URL ? [env.APP_URL] : []),
                            /^https?:\/\/.*\.test(:\d+)?$/,
                        ],
                    },
                },
                resolve: {
                    alias: Array.isArray(userConfig.resolve?.alias)
                        ? [
                              ...(userConfig.resolve?.alias ?? []),
                              ...Object.keys(defaultAliases).map((alias) => ({
                                  find: alias,
                                  replacement: defaultAliases[alias],
                              })),
                          ]
                        : {
                              ...defaultAliases,
                              ...userConfig.resolve?.alias,
                          },
                },
                ssr: {
                    noExternal: pluginConfig.ssrExternal
                        ? noExternalInertiaHelpers(userConfig)
                        : true,
                },
            };
        },
        configResolved(config) {
            resolvedConfig = config;
        },
        transform(code) {
            if (resolvedConfig.command === "serve") {
                code = code.replace(
                    /http:\/\/__wordpress_vite_placeholder__\.test/g,
                    viteDevServerUrl
                );

                return pluginConfig.transformOnServe(code, viteDevServerUrl);
            }
        },
        configureServer(server) {
            const envDir = resolvedConfig.envDir || process.cwd();
            const appUrl =
                loadEnv(resolvedConfig.mode, envDir, "APP_URL").APP_URL ??
                "undefined";

            server.httpServer?.once("listening", () => {
                const address = server.httpServer?.address();

                const isAddressInfo = (
                    x: string | AddressInfo | null | undefined
                ): x is AddressInfo => typeof x === "object";
                if (isAddressInfo(address)) {
                    viteDevServerUrl = resolveDevServerUrl(
                        address,
                        server.config
                    );
                    fs.writeFileSync(pluginConfig.hotFile, viteDevServerUrl);

                    setTimeout(() => {
                        server.config.logger.info(
                            `\n  ${colors.blue(
                                `${colors.bold(
                                    "WORDPRESS"
                                )} ${wordpressVersion()}`
                            )}  ${colors.dim("plugin")} ${colors.bold(
                                `v${pluginVersion()}`
                            )}`
                        );
                    }, 100);
                }
            });

            if (!exitHandlersBound) {
                const clean = () => {
                    if (fs.existsSync(pluginConfig.hotFile)) {
                        fs.rmSync(pluginConfig.hotFile);
                    }
                };

                process.on("exit", clean);
                process.on("SIGINT", process.exit);
                process.on("SIGTERM", process.exit);
                process.on("SIGHUP", process.exit);

                exitHandlersBound = true;
            }

            return () =>
                server.middlewares.use((req, res, next) => {
                    if (req.url === "/index.html") {
                        res.statusCode = 404;

                        res.end(
                            fs
                                .readFileSync(
                                    join(dirname(), "dev-server-index.html")
                                )
                                .toString()
                                .replace(/{{ APP_URL }}/g, appUrl)
                        );
                    }

                    next();
                });
        },
    };
}

/**
 * Validate the command can run in the given environment.
 */
function ensureCommandShouldRunInEnvironment(
    command: "build" | "serve",
    env: Record<string, string>
): void {
    if (command === "build" || env.WORDPRESS_BYPASS_ENV_CHECK === "1") {
        return;
    }

    if (typeof env.CI !== "undefined") {
        throw Error(
            "You should not run the Vite HMR server in CI environments. You should build your assets for production instead. To disable this ENV check you may set WORDPRESS_BYPASS_ENV_CHECK=1"
        );
    }
}

/**
 * The version of Wordpress being run.
 */
function wordpressVersion(): string {
    try {
        const versionPath = resolve("../../../wp-includes/version.php");
        const versionFile = fs.readFileSync(versionPath, "utf-8");
        const versionMatch = versionFile.match(/^(?:\$wp_version = )(.+?);$/m);
        let version;
        if (versionMatch && Array.isArray(versionMatch)) {
            version = versionMatch[1].replace(/['"]/g, "");
        }
        return version || "";
    } catch {
        return "";
    }
}

/**
 * The version of the Wordpress Vite plugin being run.
 */
function pluginVersion(): string {
    try {
        return JSON.parse(
            fs.readFileSync(join(dirname(), "../package.json")).toString()
        )?.version;
    } catch {
        return "";
    }
}

/**
 * Convert the users configuration into a standard structure with defaults.
 */
function resolvePluginConfig(config: PluginConfig): Required<PluginConfig> {
    if (typeof config === "undefined") {
        throw new Error("wordpress-vite-plugin: missing configuration.");
    }

    if (typeof config !== "object" || Array.isArray(config) === true) {
        throw new Error(
            "wordpress-vite-plugin: configuration must be an object."
        );
    }

    if (typeof config.namespace === "undefined") {
        throw new Error(
            'wordpress-vite-plugin: missing configuration for "namespace"'
        );
    }

    if (typeof config.input === "undefined") {
        throw new Error(
            'wordpress-vite-plugin: missing configuration for "input".'
        );
    }

    if (config.ssr === "undefined") {
        config.ssr = config.input;
    }

    if (typeof config.publicDirectory === "string") {
        config.publicDirectory = config.publicDirectory
            .trim()
            .replace(/^\/+/, "");

        if (config.publicDirectory === "") {
            throw new Error(
                "wordpress-vite-plugin: publicDirectory must be a subdirectory. E.g. 'public'."
            );
        }
    }

    if (typeof config.buildDirectory === "string") {
        config.buildDirectory = config.buildDirectory
            .trim()
            .replace(/^\/+/, "")
            .replace(/\/+$/, "");

        if (config.buildDirectory === "") {
            throw new Error(
                "wordpress-vite-plugin: buildDirectory must be a subdirectory. E.g. 'build'."
            );
        }
    }

    if (typeof config.ssrOutputDirectory === "string") {
        config.ssrOutputDirectory = config.ssrOutputDirectory
            .trim()
            .replace(/^\/+/, "")
            .replace(/\/+$/, "");
    }

    if (config.refresh === true) {
        config.refresh = [{ paths: refreshPaths }];
    }

    const defaultPublic = resolve(
        `${process.cwd()}/../../uploads/scw-vite-hmr/${config.namespace}`
    );

    const publicDirectory = config.publicDirectory ?? defaultPublic;

    return {
        namespace: config.namespace,
        input: config.input,
        publicDirectory,
        emptyOutDir: config.emptyOutDir ?? true,
        buildDirectory: config.buildDirectory ?? "build",
        ssr: config.ssr ?? config.input,
        ssrOutputDirectory:
            config.ssrOutputDirectory ?? join(publicDirectory, "ssr"),
        ssrExternal: config.ssrExternal ?? false,
        refresh: config.refresh ?? false,
        hotFile: config.hotFile ?? join(publicDirectory, "hot"),
        transformOnServe: config.transformOnServe ?? ((code) => code),
    };
}

/**
 * Resolve the Vite input path from the configuration.
 */
function resolveInput(
    config: Required<PluginConfig>,
    ssr: boolean
): string | string[] | undefined {
    if (ssr) {
        return config.ssr;
    }

    return config.input;
}

/**
 * Resolve the Vite outDir path from the configuration.
 */
function resolveOutDir(
    config: Required<PluginConfig>,
    ssr: boolean
): string | undefined {
    if (ssr) {
        return config.ssrOutputDirectory;
    }

    return join(config.publicDirectory, config.buildDirectory);
}

function resolveFullReloadConfig({
    refresh: config,
}: Required<PluginConfig>): PluginOption[] {
    if (typeof config === "boolean") {
        return [];
    }

    if (typeof config === "string") {
        config = [{ paths: [config] }];
    }

    if (!Array.isArray(config)) {
        config = [config];
    }

    if (config.some((c) => typeof c === "string")) {
        config = [{ paths: config }] as RefreshConfig[];
    }

    return (config as RefreshConfig[]).flatMap((c) => {
        const plugin = fullReload(c.paths, c.config);

        /* eslint-disable-next-line @typescript-eslint/ban-ts-comment */
        /** @ts-ignore */
        plugin.__wordpress_plugin_config = c;

        return plugin;
    });
}

/**
 * Resolve the dev server URL from the server address and configuration.
 */
function resolveDevServerUrl(
    address: AddressInfo,
    config: ResolvedConfig
): DevServerUrl {
    const configHmrProtocol =
        typeof config.server.hmr === "object"
            ? config.server.hmr.protocol
            : null;
    const clientProtocol = configHmrProtocol
        ? configHmrProtocol === "wss"
            ? "https"
            : "http"
        : null;
    const serverProtocol = config.server.https ? "https" : "http";
    const protocol = clientProtocol ?? serverProtocol;

    const configHmrHost =
        typeof config.server.hmr === "object" ? config.server.hmr.host : null;
    const configHost =
        typeof config.server.host === "string" ? config.server.host : null;
    const serverAddress = isIpv6(address)
        ? `[${address.address}]`
        : address.address;
    const host = configHmrHost ?? configHost ?? serverAddress;

    const configHmrClientPort =
        typeof config.server.hmr === "object"
            ? config.server.hmr.clientPort
            : null;
    const port = configHmrClientPort ?? address.port;

    return `${protocol}://${host}:${port}`;
}

function isIpv6(address: AddressInfo): boolean {
    return (
        address.family === "IPv6" ||
        // In node >=18.0 <18.4 this was an integer value. This was changed in a minor version.
        // See: https://github.com/laravel/vite-plugin/issues/103
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore-next-line
        address.family === 6
    );
}

/**
 * Add the Inertia helpers to the list of SSR dependencies that aren't externalized.
 *
 * @see https://vitejs.dev/guide/ssr.html#ssr-externals
 */
function noExternalInertiaHelpers(
    config: UserConfig
): true | Array<string | RegExp> {
    /* eslint-disable-next-line @typescript-eslint/ban-ts-comment */
    /* @ts-ignore */
    const userNoExternal = (config.ssr as SSROptions | undefined)?.noExternal;
    const pluginNoExternal = ["wordpress-vite-plugin"];

    if (userNoExternal === true) {
        return true;
    }

    if (typeof userNoExternal === "undefined") {
        return pluginNoExternal;
    }

    return [
        ...(Array.isArray(userNoExternal) ? userNoExternal : [userNoExternal]),
        ...pluginNoExternal,
    ];
}

/**
 * Resolve the server config from the environment.
 */
function resolveEnvironmentServerConfig(env: Record<string, string>):
    | {
          hmr?: { host: string };
          host?: string;
          https?: { cert: Buffer; key: Buffer };
      }
    | undefined {
    if (!env.VITE_DEV_SERVER_KEY && !env.VITE_DEV_SERVER_CERT) {
        return;
    }

    if (
        !fs.existsSync(env.VITE_DEV_SERVER_KEY) ||
        !fs.existsSync(env.VITE_DEV_SERVER_CERT)
    ) {
        throw Error(
            `Unable to find the certificate files specified in your environment. Ensure you have correctly configured VITE_DEV_SERVER_KEY: [${env.VITE_DEV_SERVER_KEY}] and VITE_DEV_SERVER_CERT: [${env.VITE_DEV_SERVER_CERT}].`
        );
    }

    const host = resolveHostFromEnv(env);

    if (!host) {
        throw Error(
            `Unable to determine the host from the environment's APP_URL: [${env.APP_URL}].`
        );
    }

    return {
        hmr: { host },
        host,
        https: {
            key: fs.readFileSync(env.VITE_DEV_SERVER_KEY),
            cert: fs.readFileSync(env.VITE_DEV_SERVER_CERT),
        },
    };
}

/**
 * Resolve the host name from the environment.
 */
function resolveHostFromEnv(env: Record<string, string>): string | undefined {
    try {
        return new URL(env.APP_URL).host;
    } catch {
        return;
    }
}

/**
 * The directory of the current file.
 */
function dirname(): string {
    return fileURLToPath(new URL(".", import.meta.url));
}
