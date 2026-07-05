# reader-webgpu

CarbonEngineJS-facing placeholder reader for future WebGPU package data. This
package mirrors the reader API so downstream tooling can reserve imports and
shape expectations while WebGPU package formats are designed.

The package currently defines the standalone public API shell. `Read` and
`Inspect` intentionally throw until the WebGPU package parser lands.

## Public API

The package root exports one public class: `CjsWebGPUReader`.

```js
import CjsWebGPUReader from "reader-webgpu";

const reader = new CjsWebGPUReader({
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
import { CjsWebGPUReader } from "reader-webgpu";
```

## Reader Rules

- Instance methods are PascalCase to avoid collisions with CarbonClass data.
- Static one-shot methods are camelCase and live on `CjsWebGPUReader`.
- Use `reader.SetClass(type, Class)`, `reader.SetClasses(classes)`, or
  `classes` in the options object for class hydration.
- Accepted class keys are shown in the example above and exposed as
  `CjsWebGPUReader.CLASS_KEYS`.
- Shared schema, decorators, registries, and hydration utilities belong in the
  future `core-types` package.

## Baseline Checks

```sh
npm test
npm run lint
```
