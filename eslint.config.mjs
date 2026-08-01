import config from '@iobroker/eslint-config';

export default [
  ...config,
  {
    rules: {
      // The shared config formats with 4 spaces, this repository uses 2. Reformatting
      // every file is a separate change, not part of adopting the shared rule set.
      'prettier/prettier': ['error', { tabWidth: 2 }],
      // main.js builds log messages with string concatenation throughout. Converting
      // ~120 call sites to template literals is pure churn and would collide with every
      // open branch, so it stays off until a dedicated formatting release.
      'prefer-template': 'off',
      // This adapter is plain JavaScript type-checked through JSDoc (checkJs), so
      // `/** @type {x} */ (value)` is a load-bearing cast. The rule considers @type
      // redundant and its autofix deletes the tag, which breaks `npm run check`.
      'jsdoc/check-tag-names': 'off',
    },
  },
  {
    ignores: ['node_modules/', 'doku/', '.prettierrc.js', 'admin/words.js', 'test/', '*.test.js', 'eslint.config.mjs'],
  },
];
