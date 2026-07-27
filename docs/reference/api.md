# Public API reference

Status: Evolving
Scope: `@carbonenginejs/format-webgpu`
Audience: Shader-tool authors and engine integrators
Summary: Lists the public `CjsFormatWebgpu` profile, one-shot helpers, options, and output contracts.

## Export

The package root exports `CjsFormatWebgpu` as both a named and default export:

```js
import CjsFormatWebgpu, {
    CjsFormatWebgpu as WebgpuFormat
} from "@carbonenginejs/format-webgpu";
```

## Reusable profile

Construct a profile when several operations share output, source, permutation,
schema, or class-registration options:

```js
const reader = new WebgpuFormat({
    emit: "json",
    source: "example.cewgpu",
    decodeInstructions: true,
    permutation: null
});
```

| Instance method | Purpose |
| --- | --- |
| `SetValues(options)` | Merges reusable profile defaults. |
| `GetValues(options?)` | Returns effective values with optional per-call overrides. |
| `SetClasses(classes)` | Registers several package-shape constructors. |
| `SetClass(type, Class)` | Registers or removes one constructor. |
| `GetClass(type)` | Returns one registered constructor. |
| `HasClass(type)` | Reports whether a constructor is registered. |
| `Read(bytes, options?)` | Reads CEWGPU bytes as JSON or a raw package. |
| `Inspect(bytes, options?)` | Returns a package summary. |
| `Build(chunks)` | Builds CEWGPU bytes from ordered chunks. |
| `AnalyzeEffect(bytes, options?)` | Builds normalized analysis from compiled effect bytes. |
| `BuildEffect(bytes, options?)` | Converts one selected effect pass into CEWGPU data. |
| `BuildShaderIr(input, options?)` | Builds validated shader IR from DXBC bytes or decoded input. |
| `BuildWgsl(input, options?)` | Emits a supported typed shader as WGSL. |
| `BuildWgslBindingPlan(programs, options?)` | Allocates one binding layout across a complete pass. |
| `BuildWgslSet(entries)` | Assembles emitted shaders and pass layouts. |
| `ToJSON(value)` | Converts format output to JSON-compatible data. |

`Read` currently returns plain data. Class registrations are validated and
stored for forward compatibility but do not hydrate the returned package.

## One-shot static helpers

The static helpers use lower camel case and share the implementation of the
instance methods:

| Static helper | Purpose |
| --- | --- |
| `isCewgpu(bytes)` | Checks the `CWGP` package magic. |
| `read(bytes, options?)` | Reads one package. |
| `inspect(bytes, options?)` | Inspects one package. |
| `build(chunks)` | Builds one package. |
| `analyzeEffect(bytes, options?)` | Analyzes one compiled effect. |
| `buildEffect(bytes, options?)` | Builds one selected effect pass. |
| `buildShaderIr(input, options?)` | Builds shader IR. |
| `buildWgsl(input, options?)` | Emits WGSL. |
| `buildWgslBindingPlan(programs, options?)` | Allocates a pass binding plan. |
| `buildWgslSet(entries)` | Builds a portable shader set. |
| `toJSON(value)` | Converts output to JSON-compatible data. |

## Profile options

| Option | Meaning |
| --- | --- |
| `emit` | `"json"` by default or `"raw"` for the internal package object. |
| `source` | Caller-owned diagnostic label; it is never opened. |
| `decodeInstructions` | Includes decoded instruction and shader IR detail during analysis. |
| `permutation` | Exact NAME=VALUE assertions as an array or `Map`. |
| `schema` | Optional caller schema record retained by the profile. |
| `classes` | Optional constructor registrations keyed by `CLASS_KEYS`. |

`AnalyzeEffect` decodes real selected-body stage bytes for return-only
diagnostics. `decodeInstructions: false` retains compact DXBC program metadata
without instruction or IR trees. `BuildEffect` keeps those bytes transient for
WGSL compilation and writes compact selected-body `ANLS` diagnostics instead.
Both `AnalyzeEffect` and `BuildEffect` reject malformed, duplicate, unknown, or
unresolved permutation assertions rather than silently selecting a default.

## Effect-package options

`BuildEffect` and `buildEffect` accept `mode: "selected"`, which is the default
and currently the only supported body mode. They resolve one permutation body
and emit complete passes within the requested stage selection. `mode: "all"`
fails explicitly until portable complete effect reflection is available.
The orchestration compatibility option `allPermutations: false` also means
selected mode; `allPermutations: true` fails by the same rule instead of
silently emitting one body.

The returned structural qualification does not claim a complete effect
resource. `packageValid` reports successful container construction;
`sourceComplete`, `backendComplete`, and `runtimeComplete` remain false for
the selected-body package.

## Static metadata

The class exposes output-mode constants, accepted class keys, media and input
type metadata, implementation status, the CEWGPU format label, analysis format,
and package version.

## Errors

Malformed package input and unsafe analysis paths throw or report a
`CjsWebgpuReadError` internally. Unsupported WGSL semantics fail closed with
the operation, stage, and source context needed to identify the boundary.

## Related documentation

- [Effect packaging guide](../guides/effect-packaging.md)
- [CEWGPU package format](../formats/cewgpu.md)
- [Class-purpose catalog](classes/README.md)
