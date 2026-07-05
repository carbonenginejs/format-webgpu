# @carbonenginejs/format-webgpu

CarbonEngineJS-facing placeholder reader for future WebGPU package data. This
package mirrors the reader API so downstream tooling can reserve imports and
shape expectations while WebGPU package formats are designed.

The package currently defines the standalone public API shell. `Read` and
`Inspect` intentionally throw until the WebGPU package parser lands.

## Provenance

CarbonEngine and Fenris Creations (CCP Games) are named in this package for
interoperability and schema-provenance context. This scaffold contains
CarbonEngineJS original code only unless `NOTICE` is expanded; it is not
affiliated with or endorsed by CCP Games.

## Public API

The package root exports one public class: `CjsFormatWebgpu`.

```js
import CjsFormatWebgpu from "@carbonenginejs/format-webgpu";

const reader = new CjsFormatWebgpu({
  emit: "json",       // "json" (default) | "raw"
  schema: webgpuSchema,
  classes: {
    Package: CjsWebGPUPackage,
    Resource: CjsWebGPUResource,
    Buffer: CjsWebGPUBuffer,
    Texture: CjsWebGPUTexture,
    ShaderModule: CjsWebGPUShaderModule,
    Pipeline: CjsWebGPUPipeline,
    BindGroup: CjsWebGPUBindGroup,
    Sampler: CjsWebGPUSampler,
  },
});

const json = reader.Read(buffer);
const text = JSON.stringify(reader.ToJSON(json));
```

Named import is also available:

```js
import { CjsFormatWebgpu } from "@carbonenginejs/format-webgpu";
```

## Reader Rules

- Instance methods are PascalCase to avoid collisions with CarbonClass data.
- Static one-shot methods are camelCase and live on `CjsFormatWebgpu`.
- Use `reader.SetClass(type, Class)`, `reader.SetClasses(classes)`, or
  `classes` in the options object for class hydration.
- Accepted class keys are shown in the example above and exposed as
  `CjsFormatWebgpu.CLASS_KEYS`.
- Shared schema, decorators, registries, and hydration utilities belong in the
  future `core-types` package.

## Baseline Checks

```sh
npm test
npm run lint
```
