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
fails explicitly until portable reflection is serialized for every unique
body.
The orchestration compatibility option `allPermutations: false` also means
selected mode; `allPermutations: true` fails by the same rule instead of
silently emitting one body.

`source` remains a caller-owned diagnostic label. An optional
`sourceIdentity.logicalPath` records the canonical resource identity
independently and may differ from that label. The builder records the exact
source byte length and computes a lower-case SHA-256 digest over the active
input byte view. A caller-supplied `sourceIdentity.sha256` is accepted only
when it matches that digest.

`BuildEffect` emits selected-effect INFO schema version 2 with explicit WebGPU
target, backend-package name/version, and translator name/version provenance.
The CEWGPU binary container remains version 1, and the reader retains legacy
selected-effect INFO version 1 support. Pre-PGRF INFO version 2 packages also
remain readable when both the INFO graph pointer and PGRF chunk are absent.

New packages also emit a `PGRF` permutation graph and expose it as
`result.permutationGraph`, JSON-read `permutationGraph`, and raw
`CewgpuPackage.permutationGraph`. The graph contains every ordered axis,
Cartesian permutation index, option-index tuple, source record, and
package-local unique-body key/digest. `Inspect` reports `permutationCount` and
`uniqueBodyCount`. This is complete source topology with identity-only bodies;
it does not make `mode: "all"` available.

For version-15 input, new packages also emit complete selected-body reflection
in `RFLX` and exact referenced byte payloads in `RBLB`. Build results expose
these as `result.reflection` and `result.reflectionBlobs`. JSON reads expose
`reflection` plus `reflectionBlobByteLength`; raw reads expose
`CewgpuPackage.reflection`, `reflectionBlobBytes`, and
`GetReflectionBlob(referenceOrKey)`. The latter returns an owned byte copy and
requires an object reference to match its stored key, offset, byte length, and
digest exactly. `Inspect` reports selected reflection body/source-program/blob
counts and blob byte length. Earlier source versions omit both chunks.

The returned structural qualification does not claim a complete effect
resource. `packageValid` reports successful container construction;
`sourceComplete`, `backendComplete`, and `runtimeComplete` remain false for
the selected-body package because other unique permutation bodies are not
reflected or translated.

## Static metadata

The class exposes output-mode constants, accepted class keys, media and input
type metadata, implementation status, the CEWGPU format label, analysis format,
and package version.

## Errors

Malformed package input and unsafe analysis paths throw or report a
`CjsWebgpuReadError` internally. Unsupported WGSL semantics fail closed with
the operation, stage, and source context needed to identify the boundary.
Duplicate/non-ASCII chunk tags are rejected. A declared
`tr2-effect-webgpu` package also fails closed on missing or malformed JSON
chunks, unsupported document versions, or inconsistent INFO/META/ANLS/WGSL
identity, counts, keys, layouts, selection, and completeness fields. Declared
PGRF pointers, schemas, counts, variant tuples, body references, and the
selected index/options are reconciled as part of the same gate. Optional
INFO/RFLX/RBLB reflection units additionally reconcile source/body identity,
portable closed schemas, exact blob references/digests, and ANLS pass/stage
source identities.
Strict effect validation is activated by the `INFO.packageKind` marker;
effect-only consumers must require that marker because unmarked CEWGPU
containers intentionally remain generic.

## Related documentation

- [Effect packaging guide](../guides/effect-packaging.md)
- [CEWGPU package format](../formats/cewgpu.md)
- [Class-purpose catalog](classes/README.md)
