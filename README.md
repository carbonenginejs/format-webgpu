# @carbonenginejs/format-webgpu

Reads and builds CEWGPU shader packages and translates supported compiled DXBC
effect stages into portable WGSL package data.

Use this package for browser-safe effect analysis, WGSL emission, binding
planning, and `.cewgpu` assembly. It consumes effect metadata from
`@carbonenginejs/format-hlsl` and decoded shader programs from
`@carbonenginejs/format-dxbc`; `@carbonenginejs/engine-webgpu` consumes the
result and owns live GPU objects.

## Install

```sh
npm install @carbonenginejs/format-webgpu
```

## Quick start

Inspect and read caller-supplied CEWGPU bytes:

```js
import { CjsFormatWebgpu } from "@carbonenginejs/format-webgpu";

const summary = CjsFormatWebgpu.inspect(packageBytes);
const packageData = CjsFormatWebgpu.read(packageBytes);

console.log(summary.version, packageData.wgsl);
```

The same public class can analyze compiled effect bytes, build validated shader
IR, emit WGSL, allocate one binding plan across a complete pass, and assemble
the result as CEWGPU data. Unsupported shader semantics fail explicitly.

## Documentation

- [Package documentation](docs/README.md)
- [Architecture and boundaries](docs/architecture.md)
- [Effect packaging guide](docs/guides/effect-packaging.md)
- [Public API reference](docs/reference/api.md)
- [CEWGPU package format](docs/formats/cewgpu.md)
- [WGSL compatibility](docs/reference/wgsl-compatibility.md)
- [Class-purpose catalog](docs/reference/classes/README.md)

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE). CarbonEngine and Fenris
Creations (CCP Games) are named for interoperability and provenance context.
This project contains CarbonEngineJS original code unless `NOTICE` states
otherwise and is not affiliated with or endorsed by CCP Games.
