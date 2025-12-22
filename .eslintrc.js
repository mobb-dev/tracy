const fs = require('fs');
const path = require('path');

// Path to the shared eslint config in the workspace
const sharedConfigPath = path.resolve(__dirname, '../../tscommon/eslint-config-custom/index.js');

let config;

// Check if we're in a workspace context and the shared config exists
if (fs.existsSync(sharedConfigPath)) {
  // Use the shared config as base
  const sharedConfig = require(sharedConfigPath);

  config = {
    ...sharedConfig,
    parserOptions: {
      ...sharedConfig.parserOptions,
      project: "./tsconfig.eslint.json"
    },
    env: {
      ...sharedConfig.env,
      node: true
    },
    overrides: [
      ...(sharedConfig.overrides || []),
      {
        files: ["__tests__/**/*.{ts,tsx,mts,cts}"],
        rules: {
          "@typescript-eslint/no-explicit-any": "off"
        }
      }
    ]
  };
} else {
  // Fallback config for standalone context (when workspace config doesn't exist)
  config = {
    root: true,
    extends: [
      "eslint:recommended",
      "@typescript-eslint/recommended"
    ],
    parser: "@typescript-eslint/parser",
    parserOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      project: "./tsconfig.eslint.json"
    },
    plugins: ["@typescript-eslint"],
    env: {
      node: true,
      es2021: true
    },
    overrides: [
      {
        files: ["__tests__/**/*.{ts,tsx,mts,cts}"],
        rules: {
          "@typescript-eslint/no-explicit-any": "off"
        }
      }
    ]
  };
}

module.exports = config;
