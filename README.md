# @carbonenginejs/format-webgpu

CarbonEngineJS-facing reader/builder for `.cewgpu` WebGPU package data, plus
an offline effect-analysis helper built on `@carbonenginejs/format-hlsl` and
`@carbonenginejs/format-dxbc`.

Phase 1 implements:

- CEWGPU package `Read`, `Inspect`, and `Build`
- an offline `AnalyzeEffect(...)` path for compiled `.sm_*` effect payloads
- normalized binding + stage + DXBC analysis JSON suitable for future WGSL work
- validated front-end shader IR with declarations, explicit binding ranges,
  DXBC source offsets, executable instructions, structured CFG edges, and
  deterministic basic blocks
- component-granular register versions, masked-write reconstruction,
  cross-block SSA merges, signature/opcode/resource-driven scalar types, and
  explicit typeless-register reinterpret records
- deterministic `BuildWgsl(...)` emission for the strict mov-only vertex slice
  and the bounded SM5.0 copyblit fragment slice, including typed statements,
  canonical resource layouts, and DXBC-offset source maps

General control flow and general vertex WGSL emission remain later passes. A
bounded SM5.1 fragment path supports nested no-else selections with scalar
float component merges; loops, switches, else arms, mixed merge types, and
observable undefined merge inputs remain rejected.

## Provenance

CarbonEngine and Fenris Creations (CCP Games) are named in this package for
interoperability and schema-provenance context. This package contains
CarbonEngineJS original code only unless `NOTICE` is expanded; it is not
affiliated with or endorsed by CCP Games.

## Public API

The package root exports one public class: `CjsFormatWebgpu`.

```js
import CjsFormatWebgpu from "@carbonenginejs/format-webgpu";

const reader = new CjsFormatWebgpu({
  emit: "json",              // "json" (default) | "raw"
  source: "quadv5.cewgpu",   // name used in error details
  decodeInstructions: true,  // used by AnalyzeEffect
  permutation: null,         // used by AnalyzeEffect
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

const pkg = reader.Read(packageBytes);
const summary = reader.Inspect(packageBytes);
const analysis = reader.AnalyzeEffect(effectBytes, {
  permutation: [ { name: "QUALITY", value: "HIGH" } ],
  decodeInstructions: false
});
const vertexShader = reader.BuildWgsl(vertexDxbcBytes);
const fragmentShader = reader.BuildWgsl(dx11FragmentDxbcBytes);
const wgslSet = reader.BuildWgslSet([
  { key: "Main.pass0.vertex", shader: vertexShader },
  { key: "Main.pass0.pixel", shader: fragmentShader }
]);
const built = reader.Build([
  [ "INFO", { format: "CEWGPU", formatVersion: 1 } ],
  [ "META", { effectName: "quadv5" } ],
  [ "ANLS", analysis ]
]);
const text = JSON.stringify(reader.ToJSON(pkg));
```

Named import is also available:

```js
import { CjsFormatWebgpu } from "@carbonenginejs/format-webgpu";
```

One-shot statics follow the same conventions:

```js
CjsFormatWebgpu.isCewgpu(packageBytes);     // chunked package magic sniff
CjsFormatWebgpu.read(packageBytes);         // package JSON
CjsFormatWebgpu.inspect(packageBytes);      // package summary
CjsFormatWebgpu.build(chunks);              // package bytes
CjsFormatWebgpu.analyzeEffect(effectBytes); // normalized effect analysis JSON
CjsFormatWebgpu.buildShaderIr(dxbcBytes);   // frozen front-end shader IR
CjsFormatWebgpu.buildWgsl(dxbcBytes);       // typed WGSL descriptor (supported slices)
CjsFormatWebgpu.buildWgslSet(entries);      // portable shaders + pass layouts
```

## Package Shape

CEWGPU is a CarbonEngineJS-invented flat chunk container, mirroring CEWG's
simple package rules:

- magic: `CWGP`
- format label: `CEWGPU`
- version: `1`
- common chunks: `INFO`, `META`, `ANLS`, `WGSL`

`ANLS` is the current phase-1 workhorse. It stores JSON describing:

- the selected permutation/body index
- Carbon pass and register bindings
- per-stage shader bytecode metadata
- DXBC container/program/signature/instruction decode per stage
- frozen front-end shader IR per decoded stage when instruction decoding is
  enabled

`WGSL` may hold raw WGSL or JSON stage/shader sets. Current emission covers the
copyblit mov-only vertex plus bounded SM5.0 and SM5.1 fragment paths. The SM5.1
slice lowers nested no-else scalar float phis to typed function variables and
true-edge assignments; this is not general control-flow lowering.
JSON `CJS_WGSL_SET` records may also include optional pass-level `layouts`.
Those records carry canonical numeric bind groups and the exact buffer,
texture, and sampler layout used by emitted WGSL; they are exposed separately
from ANLS Carbon metadata without changing CEWGPU container version 1.
`BuildWgslSet` validates those emitted numeric slots across the stages in each
pass. It unions compatible stage visibility, rejects identity or slot
collisions, and never renumbers bindings because the WGSL source already owns
its `@group` and `@binding` attributes.

## Reader Rules

- Instance methods are PascalCase to avoid collisions with CarbonClass data.
- Static one-shot methods are camelCase and live on `CjsFormatWebgpu`.
- Use `reader.SetClass(type, Class)`, `reader.SetClasses(classes)`, or
  `classes` in the options object for class hydration.
- Accepted class keys are exposed as `CjsFormatWebgpu.CLASS_KEYS`.
- `Read` / static `read` parse `.cewgpu` package bytes.
- `AnalyzeEffect` / static `analyzeEffect` consume compiled `.sm_*` effect
  bytes, not `.cewgpu` package bytes.
- Shared schema, decorators, registries, and hydration utilities belong in the
  future `core-types` package.

## Baseline Checks

```sh
npm test
npm run lint
```

To package an effect whose selected stages are all inside the currently
supported WGSL slice:

```powershell
npm.cmd run package:effect -- E:\path\copyblit.sm_hi E:\path\copyblit.cewgpu
```

The plain-JavaScript command retains `ANLS` stage metadata and adds the
generated `CJS_WGSL_SET` plus canonical pass layouts. It fails explicitly when
any selected stage is not yet supported by the WGSL compiler.

To qualify a paired DX11/DX12 corpus without treating expected WGSL emitter
boundaries as front-end failures:

```powershell
npm.cmd run qualify:effects -- E:\path\effect.dx11 E:\path\effect.dx12
```

The command recursively pairs `.sm_lo`, `.sm_hi`, and `.sm_depth` files by
relative path, decodes every selected stage through the current sibling
`format-dxbc` source, and records IR/CFG/type metrics plus the first WGSL
emitter result as JSON. Missing pairs, stage-key drift, decode failures, and IR
failures set a nonzero exit code; a reported `unsupported` WGSL stage does not.
Optional relative paths after the two roots restrict the run to a qualification
ladder.
Use `--summary` before the two roots to emit only corpus and per-pair counts
during a full-corpus gate.
