Vendored ES modules for the dashboard. No build step: served as-is, and work offline on the LAN.
Fetched with `npm pack` (which verifies the registry integrity hash). To upgrade, repack the new
versions, copy the same dist files over, and update this table.

file             from package                        version   license      source file in the tarball
preact.js        preact                              10.29.8   MIT          dist/preact.module.js
preact-hooks.js  preact (hooks)                      10.29.8   MIT          hooks/dist/hooks.module.js
htm.js           htm                                 3.1.1     Apache-2.0   dist/htm.module.js
signals.js       @preact/signals                     2.11.2    MIT          dist/signals.module.js
signals-core.js  @preact/signals-core                1.14.4    MIT          dist/signals-core.module.js

npm integrity (sha512 of each package tarball):
  preact@10.29.8                sha512-ej2aVZ+vZ8WO7tvlQWRM9N63A0KzF9q4mWJfDUHgYaIofWY9hu74QdnQrjoPMmZi2/nZ5gN0bJCQF49xQqx09Q==
  htm@3.1.1                     sha512-983Vyg8NwUE7JkZ6NmOqpCZ+sh1bKv2iYTlUkzlWmA5JD2acKoxd4KVxbMmxX/85mtfdnDmTFoNKcg5DGAvxNQ==
  @preact/signals@2.11.2        sha512-rVTRTt/T0HIRgbugwS5FigbfF/kfdEFYFtiqxa+lbpqTajepqnR0firuAS2iNdHyejWB7Yc9p9QePkVNBtTAwg==
  @preact/signals-core@1.14.4   sha512-HNB6HYeYKhQbJ1aKl+YRjrS4+QWHLKX6qKoUsfS/m0vqzsVaEBiZiaKbG/e+NKk2ch5ALQr/ihWaMHxiCuuWHA==

The bare imports inside these files ("preact", "preact/hooks", "@preact/signals-core") are resolved by
the import map in public/ui/index.html. Licenses: LICENSE-preact, LICENSE-htm, LICENSE-signals.
