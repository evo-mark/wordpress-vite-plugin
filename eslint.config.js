import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import js from "@eslint/js";

export default tseslint.config(
    {
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
    },
    eslint.configs.recommended,
    tseslint.configs.recommended,
    {
        rules: {
            "no-trailing-spaces": "error",
        },
    }
);
