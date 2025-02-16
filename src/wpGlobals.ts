import externalGlobals from "rollup-plugin-external-globals";

interface GlobalsConfig {
    localReact ?: boolean;
}

/**
 * Given a kebab-case string, returns a new camelCase string.
 *
 * @param {string} str Input kebab-case string.
 * @return {string} Camel-cased string.
 */
function camelCaseDash(str: string): string {
    return str.replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());
}

function wp_globals(config: GlobalsConfig) {
    const wpModules = [
        "a11y",
        "annotations",
        "api-fetch",
        "autop",
        "blob",
        "block-directory",
        "block-editor",
        "block-library",
        "block-serialization-default-parser",
        "blocks",
        "components",
        "compose",
        "core-data",
        "data",
        "data-controls",
        "date",
        "deprecated",
        "dom",
        "dom-ready",
        "edit-post",
        "editor",
        "element",
        "escape-html",
        "format-library",
        "hooks",
        "html-entities",
        "i18n",
        "is-shallow-equal",
        "keyboard-shortcuts",
        "keycodes",
        "list-reusable-blocks",
        "media-utils",
        "notices",
        "nux",
        "plugins",
        "primitives",
        "priority-queue",
        "redux-routine",
        "reusable-blocks",
        "rich-text",
        "server-side-render",
        "shortcode",
        "token-list",
        "url",
        "viewport",
        "warning",
        "wordcount",
    ];

    const otherModules: Record<string, string> = {
        jquery: "jQuery",
        tinymce: "tinymce",
        moment: "moment",
        backbone: "Backbone",
        lodash: "lodash",
    };
    if (config.localReact !== true) {
        otherModules.react = "React";
        otherModules["react-dom"] = "ReactDOM";
    }

    return {
        ...otherModules,
        ...Object.fromEntries(
            wpModules.map((handle) => [
                `@wordpress/${handle}`,
                `wp.${camelCaseDash(handle)}`,
            ])
        ),
    };
}

export default function (config: GlobalsConfig = {}) {
    return externalGlobals(wp_globals(config));
}
