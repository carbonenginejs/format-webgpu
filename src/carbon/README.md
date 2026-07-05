# src/carbon

This folder is a temporary home for CarbonEngine/library-shaped classes that
are needed by this reader or tooling package before their proper standalone
library exists.

Classes here are transient:

- They are not the reader boundary API.
- Keep the public reader class in `src/Cjs*Reader.js`.
- Keep parser, codec, conversion, and validation helpers in `src/core`.
- Move these classes into the correct standalone library package when that
  package exists.
- Preserve provenance, legal notices, schema mappings, and migration notes when
  moving them.

Do not treat imports from this folder as stable public API unless the package
README explicitly says otherwise.
