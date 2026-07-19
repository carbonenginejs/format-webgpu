# @carbonenginejs/format-webgpu

CarbonEngineJS-facing reader/builder for `.cewgpu` WebGPU package data, plus a
browser-safe compiled-effect to WGSL package pipeline built on
`@carbonenginejs/format-hlsl` and `@carbonenginejs/format-dxbc`.

The current phase-1 slice implements:

- CEWGPU package `Read`, `Inspect`, and `Build`
- complete byte-in/byte-out `BuildEffect(...)` conversion for the currently
  supported WGSL slice
- an offline `AnalyzeEffect(...)` path for compiled `.sm_*` effect payloads
- normalized binding, stage, and DXBC analysis JSON consumed by current WGSL
  lowering and retained as package provenance
- validated front-end shader IR with declarations, explicit binding ranges,
  DXBC source offsets, executable instructions, structured CFG edges, and
  deterministic basic blocks
- component-granular register versions, masked-write reconstruction,
  cross-block SSA merges, signature/opcode/resource-driven scalar types, and
  explicit typeless-register reinterpret records
- deterministic `BuildWgsl(...)` emission for bounded straight-line SM5.0 and
  SM5.1 vertex programs, including packed `sincos -> lt -> and -> movc` math,
  signed `iadd`, and raw `ld_structured` reads from read-only storage buffers
- a bounded fragment slice with exact integer/reinterpretation flow through
  `iadd -> itof`, conditional `discard`, dot products, texture sampling,
  rounding, typed statements, canonical resource layouts, and DXBC-offset
  source maps
- parameterless fragment entry points when declared pixel inputs are not live;
  dead input signatures are omitted while output signatures remain mandatory
- component-wise fragment `frc` and `round_ni`, emitted as WGSL `fract` and
  round-toward-negative-infinity `floor` respectively
- pass-global `BuildWgslBindingPlan(...)` allocation so separately emitted
  vertex and pixel modules retain one collision-free canonical layout
- strict complete-pass selection in `package:effect`, allowing a supported
  pass to be packaged while full-effect ANLS provenance is retained

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
const packaged = reader.BuildEffect(effectBytes, {
  source: "res:/graphics/effect.dx11/managed/space/quadv5.sm_hi",
  permutation: [ { name: "QUALITY", value: "HIGH" } ],
  selection: {
    techniqueName: "Main",
    passIndex: 0,
    stageNames: [ "vertex", "pixel" ]
  }
});
const vertexIr = reader.BuildShaderIr(vertexDxbcBytes);
const fragmentIr = reader.BuildShaderIr(dx11FragmentDxbcBytes);
const bindingPlan = reader.BuildWgslBindingPlan([ vertexIr, fragmentIr ]);
const vertexShader = reader.BuildWgsl(vertexIr, { bindingPlan });
const fragmentShader = reader.BuildWgsl(fragmentIr, { bindingPlan });
const wgslSet = reader.BuildWgslSet([
  { key: "Main.pass0.vertex", shader: vertexShader },
  { key: "Main.pass0.pixel", shader: fragmentShader }
]);
const built = reader.Build([
  [ "INFO", { format: "CEWGPU", formatVersion: 1 } ],
  [ "META", { effectName: "quadv5" } ],
  [ "ANLS", analysis ],
  [ "WGSL", wgslSet ]
]);
const text = JSON.stringify(reader.ToJSON(pkg));
```

### `BuildEffect(effectBytes, options)` / `buildEffect(effectBytes, options)`

Converts one compiled `.sm_*` effect entirely from caller-supplied bytes. It
performs exact permutation validation, complete-pass selection, DXBC-to-IR and
WGSL lowering, pass-global binding allocation, CEWGPU assembly, and package
inspection. The result contains `{ bytes, info, metadata, analysis, wgsl,
inspection, qualification }`. Successful conversion is structurally qualified
by the browser pipeline. Native comparison, when a target requires it, is a
separate Node qualification layer and does not change browser correctness.

The implementation under `src/core` has no filesystem, path, process, or
native-executable dependency, so browsers can fetch or select `.sm_*` bytes and
convert them directly. Unsupported shader semantics throw instead of silently
publishing a partial package.

`npm run package:effect -- <input.sm_*> <output.cewgpu>` is only a Node file
adapter over that same API. It refuses an existing output unless
`--overwrite` or `--force` is supplied and never overwrites its input. Native
HLSLcc comparison is not part of `BuildEffect`. Executable discovery and output
comparison belong to a format-webgpu Node qualifier; tools-core may coordinate
that format-owned qualifier for a target that requires it but must not own the
executable or comparison implementation.

### Indexed corpus builds

Do not use the format-local command to acquire or rebuild an indexed EVE or
Frontier corpus. Agents producing packages for an engine, harness, build report,
or persistent resource overlay must run the canonical tools-core builder from
`E:\carbonenginejs-org\tools-core`:

```powershell
npm.cmd run build:shader:webgpu -- --shader-target eve-webgpu --build latest --out <output>
```

Add `--diagnostic` to retain unsupported/failed entries for compiler audit, or
`--force --no-reuse` to transactionally replace and rebuild an existing output.
The command writes `build-report.json`, durable JSONL progress, and a structured
failure report. EVE WebGPU currently uses structural qualification and records
native comparison as `pending-audit`. No Frontier WebGPU target is registered;
a future target must require this package's Node-owned `native-hlslcc` qualifier.

The dependency direction is deliberately tools-core -> format-webgpu.
tools-core imports only this package's public root `CjsFormatWebgpu` class; its
transitive HLSL/DXBC imports are format-webgpu's concern. Do not add tools-core
as a format or browser dependency. Direct `buildEffect` use remains correct for
browser conversion, library tests, paired compiler qualification, and explicit
one-file diagnostics.

A D3D `(resource class, register space, register index)` tuple is stage-local
unless pass metadata confirms it names one shared resource. The version-2
binding plan retains that tuple as `identity` and carries a separate
`scopeIdentity`. Every unshared version-2 binding receives an `@vertex` or
`@fragment` scope, including a tuple used by only one pass stage. The compact
base scope is reserved for a compatible resource that `CjsLibrary` or another
policy owner explicitly confirms is shared across stages:

```js
const bindingPlan = reader.BuildWgslBindingPlan([ vertexIr, fragmentIr ], {
  sharedIdentities: [ "uniform-buffer:0:0" ]
});
```

The planner input must contain the complete stage set that will later be
combined into one pass. Do not plan vertex and pixel modules independently and
then combine them: only one complete-pass plan can decide whether a repeated
tuple is local or explicitly shared.

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
CjsFormatWebgpu.buildEffect(effectBytes);   // complete browser-safe CEWGPU package
CjsFormatWebgpu.buildShaderIr(dxbcBytes);   // frozen front-end shader IR
CjsFormatWebgpu.buildWgslBindingPlan(irs);  // pass-global canonical slots
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

`WGSL` may hold raw WGSL or JSON stage/shader sets. Current emission covers a
bounded straight-line arithmetic/resource-using vertex path plus bounded
SM5.0 and SM5.1 fragment paths. The SM5.1 fragment slice lowers nested no-else
scalar float phis to typed function variables and true-edge assignments; this
is not general control-flow lowering. A fragment whose executable program reads
no input register emits no empty input structure and uses `fn main() ->
FragmentOutput`; declared-but-dead inputs do not block emission.
JSON `CJS_WGSL_SET` version-2 records may also include optional pass-level `layouts`.
Those records carry canonical numeric bind groups and the exact buffer,
texture, and sampler layout used by emitted WGSL; they are exposed separately
from ANLS Carbon metadata without changing CEWGPU container version 1.
`BuildWgslSet` validates those emitted numeric slots across the stages in each
pass. Each binding retains its base D3D `identity` plus the resource-resolution
`scopeIdentity`. The builder unions visibility only for one explicitly shared
base scope, requires that scope to cover multiple stages, permits stage-scoped
declarations of the same D3D tuple at distinct slots, rejects mixed shared/
stage-scoped forms, duplicate scopes, or duplicate slots, and never renumbers
bindings because the WGSL source already owns its `@group` and `@binding`
attributes. Version-1 binding plans remain accepted as a legacy input; all
newly built plans and sets are version 2. When a v1 plan is consumed, its
unshared entries normalize to stage-qualified scopes while identities listed in
its legacy `sharedIdentities` metadata retain their shared base scope.

## Reader Rules

- Instance methods are PascalCase to avoid collisions with CarbonClass data.
- Static one-shot methods are camelCase and live on `CjsFormatWebgpu`.
- `reader.SetClass(type, Class)`, `reader.SetClasses(classes)`, and the
  `classes` option currently validate/store registrations only; `Read` returns
  plain package data and does not instantiate those classes yet.
- Accepted registration keys are exposed as `CjsFormatWebgpu.CLASS_KEYS`.
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

The packaging and qualification commands below are repository-only development
gates. They are not included in the published package tarball while they depend
on corrected sibling decoder source.

To package a complete pass whose stages are inside the currently supported
WGSL slice:

```powershell
npm.cmd run package:effect -- `
  E:\path\quadv5.sm_lo `
  E:\path\quadv5-main.cewgpu `
  --permutation BINDLESS_RENDERING=BINDLESS_RENDERING_DISABLED `
  --permutation SPACE_OBJECT_CLIPPING=SOC_DISABLED `
  --permutation SPACE_OBJECT_PPT_ENABLED=SOPPT_ENABLED `
  --permutation SPACE_OBJECT_TRANSPARENCY=SOT_OPAQUE `
  --permutation V5_DEBUG=OFF `
  --permutation SPACE_OBJECT_INSTANCED_ATTACHMENT=SOIA_DISABLED `
  --permutation BLEND_MODE=BLEND_MODE_OVERLAY `
  --technique Main --pass 0 --stage vertex --stage pixel
```

The exact, case-sensitive stage list asserts that the selected pass is
complete. The command retains every `ANLS` pass/stage record, emits WGSL only
for the selected pass, records the selection in `META.wgslSelection`, and
builds one pass-global binding plan before emitting either stage. It fails
explicitly for a missing/incomplete selection, an unknown or unresolved
`--permutation NAME=VALUE` assertion, or an unsupported selected stage.
Assert every axis when the output must be reproducible independently of
effect defaults or registered global options.
With no selector flags, the legacy all-stage behavior remains in effect.

The packaging and qualification scripts decode through the published
`@carbonenginejs/format-dxbc` dependency. Version 0.1.2 is the minimum because
it contains the required SM5.1 constant-buffer correction for standalone DX12
byte-input use.

To qualify a paired DX11/DX12 corpus without treating expected WGSL emitter
boundaries as front-end failures:

```powershell
npm.cmd run qualify:effects -- E:\path\effect.dx11 E:\path\effect.dx12
```

The corpus qualifier resolves the default permutation of each paired file. To
exercise every mixed-radix permutation body, every declared technique, and
every active pass in one exact DX11/DX12 pair, use the pass-global matrix gate:

```powershell
npm.cmd run qualify:matrix -- --summary --output E:\path\matrix.json E:\path\dx11\effect.sm_lo E:\path\dx12\effect.sm_lo
```

The matrix runner parses each effect once, compares permutation axes and active
pass topology by body index, caches identical DXBC programs, then runs binding
planning, WGSL emission, and `BuildWgslSet` per distinct pass program. The full
report records every body-to-variant mapping, empty techniques, independently
emitted shader modules, pass-ready variants, and occurrence-weighted unsupported
boundaries. It never guesses that a repeated D3D identity is shared: repeated
tuples receive separate stage scopes, while `CjsLibrary` or a calling test
preset may explicitly confirm compatible sharing.

The 2026-07-18 exact `spaceobject/unpacked_quadv5.sm_lo` 480-body matrix
qualifies all 8,960 stage occurrences through the front end. The complete
`iadd -> itof -> conditional-discard` family now emits, so DX11 emits all
4,480 stages and prepares all 2,240 passes. DX12 emits 4,120 stages and
prepares 1,880 passes; its remaining 360 occurrences are only the explicit
bindless sampled-resource range boundary. The required browser gate compiled
47 unique modules and prepared 76 unique pipelines, covering 8,600 emitted
stage occurrences and 4,120 ready pass occurrences with zero WGSL warnings.

The packed `spaceobject/quadv5.sm_lo` 480-body pair reaches the same exact
counts and browser gate after adding paired `sincos` writes and the complete
mask-selection chain. The strict 240-body
`spaceobject/unpackedskinned_quadv5.sm_lo` pair proves raw structured bone
loads as `array<u32>` read-only storage: DX11 emits 1,600/2,240 stages and
DX12 emits 1,420/2,240, with 480/1,120 ready passes per backend. Its browser
gate compiled 33 modules and prepared 8 pipelines, covering 3,020 emitted
stages and 960 ready passes with zero warnings. The structured vertex `t0` and
pixel texture `t0` now receive independent stage scopes and slots; the former
incompatible-declaration boundary is gone. Readiness is unchanged because the
same passes next reach unsupported exact DXBC `precise` controls. The remaining
skinned boundaries are `precise` and the DX12 bindless range. There is no
relaxed-precision escape hatch.

The `qualify:effects` command recursively pairs `.sm_lo`, `.sm_hi`, and `.sm_depth` files by
relative path, decodes every selected stage through the current sibling
`format-dxbc` source, and records IR/CFG/type metrics plus the first WGSL
emitter result as JSON. Missing pairs, stage-key drift, decode failures, and IR
failures set a nonzero exit code; a reported `unsupported` WGSL stage does not.
Optional relative paths after the two roots restrict the run to a qualification
ladder.
Use `--summary` before the two roots to emit only corpus and per-pair counts
during a full-corpus gate.
