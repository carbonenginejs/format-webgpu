# format-webgpu Compatibility Ledger

Status: current as of 2026-07-20.

This ledger records every deliberate divergence between the DXBC contract and
the emitted WGSL, every fail-closed boundary, and every bounded/temporary
support decision. Consult and update it whenever compiler behavior changes;
each entry says why it exists and what revisiting it would take. Categories:

- **Adapted** — accepted input whose WGSL semantics deliberately differ from
  the exact D3D contract. These are the entries to re-read first when hunting
  a rendering difference against the native client.
- **Not supported (fail closed)** — inputs the compiler rejects with an
  explicit diagnostic rather than guessing.
- **Bounded / temporary** — supported within stated limits; the limits are the
  first thing to widen when a shader trips them.

## Adapted

### `precise` floating-point operations → ordinary math + `@invariant` position

Requester decision, 2026-07-20 (org `.agents/DECISIONS.md`). DXBC `precise`
forbids reassociation/fusion so multi-pass position math is bit-identical.
WGSL has no general no-contraction control, so instead of rejecting these
operations (the pre-2026-07-20 wall that capped the Medium/High decal and
skinned-quad tiers):

- `precise`-marked operations lower as ordinary IEEE float math;
- every vertex `SV_Position` output is emitted `@invariant @builtin(position)`
  (unconditionally, all vertex shaders), which guarantees identical position
  results across pipelines built from the same emitted WGSL — the multi-pass
  crack/z-fight artifact `precise` protects against;
- precise-mask metadata is still validated structurally (well-formed mask,
  lanes covered by a destination write) in
  `src/core/wgsl/precisionControls.js`.

NOT promised: bit-exact arithmetic parity with native D3D11; differential
tests against native output may differ in final ulps. Globally-non-refactorable
shaders (missing `REFACTORING_ALLOWED`) remain rejected — that contract is
stronger and genuinely unrepresentable. Revisit: if WGSL ever gains a
no-contraction control, restore exact lowering and drop this entry.

### DXBC comparison masks → `select` masks

DXBC comparisons produce 0xFFFFFFFF/0 integer masks; WGSL comparisons produce
`bool`. All comparison opcodes (`lt/ge/eq/ne`, `ilt/ige/ieq/ine`, `ult/uge`)
lower as `select(0u, 0xffffffffu, a OP b)` so downstream mask arithmetic
(`and`/`movc` chains) stays bit-faithful.

### Typeless registers → per-lane storage types with explicit bitcasts

DXBC registers are typeless 32-bit lanes. The type-inference union assigns one
storage type per SSA lane (conflicts become `bitpattern32` = `u32`) and every
crossing emits an explicit `bitcast`. Mixed-component writes (one instruction
writing lanes of different resolved types) split into per-component `let`s
(`valueN_x`, …) for immediate movs, structured loads, packed intrinsic
projections, and per-lane `movc` selects — in BOTH stages.

### SSA-legal cross-scope reads → hoisted function-top `var`s

SSA may resolve a post-join read to one arm's definition (the other path
diverges via return/discard); structured WGSL scoping cannot express that
directly. `src/core/wgsl/hoistEscapingValues.js` hoists escaping declarations
to uninitialized function-top `var`s (WGSL zero-initializes) plus in-place
assignments. The zero is unobservable — SSA proves the value is only read on
assigning paths.

### Switch clauses without a `default` → empty WGSL `default`

WGSL requires a `default` clause; DXBC switches without one fall through to
`endswitch`. The emitter appends an empty `default: {}`. Switches carrying
live merges DO require a real DXBC default (fail closed otherwise).

### `SV_IsFrontFace` → `front_facing` mask projection

DXBC reads the front-face flag as a 0xFFFFFFFF/0 mask; WGSL's builtin is
`bool`. Consumers receive `select(0u, 0xffffffffu, front_facing)` (or the
signed variant).

### Selection arms may write outputs alongside a live merge

A vertex `if`/`else` whose arms write shader outputs (typically `SV_Position`
in a Picking/stretch pass — one arm computes the real transform, the other
writes a constant/off-screen position) AND also carry a scalar phi merge
(e.g. a `TEXCOORD` lane read after the join) used to be rejected outright.
Output writes inside a branch compose correctly with the merge machinery: the
merge `var` is pre-declared before the `if` and assigned at each arm's end,
while output completeness is enforced by the post-branch component
intersection and the reachable-`ret` coverage check. The guard is therefore
removed for selections; the genuine "terminates before merge assignments"
(return inside an arm ahead of the appended merge write) guard stays.
Browser-validated on `banner` (Main + Picking, DX11 and DX12, zero warnings).

### `continue`/`continuec` in loops → WGSL `continuing {}` latch

Loop phi-latch updates are emitted in a WGSL `continuing {}` block (which runs
on both fall-through and `continue` paths) instead of being appended to the loop
body. `continue` lowers to `continue;` and `continuec` to `if (cond) { continue;
}`. Behavior is unchanged for loops without `continue` (the continuing block
still runs the latch each iteration); it simply makes body `continue` correct
rather than skipping the latch. Both stages.

### Declared-but-unwritten location outputs → zero-filled

A vertex/fragment output signature may declare a `location` varying
(COLOR/TEXCOORD) that a given permutation never writes (e.g. `ui/ubershader3d`
declares COLOR1/TEXCOORD4 but the default permutation writes neither). D3D
leaves such lanes undefined; WGSL zero-initializes `var output`, so the
unwritten lanes read as 0 — a safe, valid choice. Completeness is still enforced
for **builtin** outputs (`SV_Position` must be fully written; zero is not a
meaningful position).

### Dead untyped temp writes → skipped

Compiler-emitted dead stores whose values nothing reads (and whose types are
therefore unresolvable) are dropped instead of failing the module.

### Terminal control flow → dead tail dropped

An `if`/`else` whose both arms return, or a `switch` with a default whose every
clause returns, terminates all paths; instructions after it (a trailing
unreachable `ret`, common after fully-branched Picking/depth outputs) are dead
and not lowered. Output-completeness is validated only on reachable `ret`s.

### `immediate_constant_buffer` (DXBC icb) → module `const` array

DXBC's inline constant table (`customdata`, dataClass 3) is emitted as a
module-scope `const icb = array<vec4<f32>, N>(vec4<f32>(...), ...)` with each
lane a round-tripping f32 decimal literal (non-finite lanes fall back to
`bitcast<f32>(0x..u)`), and `immediate_constant_buffer` operands lower as
`icb[<index>].<comp>` reusing the dynamic constant-buffer index machinery
(pure-relative and base+relative indices both supported), with int/uint
consumers bitcast exactly like uniform cbuffers.

### Component-packed varyings → one merged interface field per register

DXBC signature tables can emit several rows for a single interpolant register
when distinct semantics occupy different lanes (e.g. three `TEXCOORD`s packed
into `x`/`y`/`z` of output register 2, as in `starsprites`). Each row carries a
non-prefix mask (`y`-only, `z`-only) that would individually be rejected as a
gap in the WGSL location layout. Both stages now group signature rows by
`registerIndex`, union their masks, and emit ONE interface field per register
(validated prefix, single component type across the group). This is a
faithfulness fix, not a divergence — the merged field reproduces the register's
true lane occupancy.

### Vertex-stage texture sampling → explicit LOD/gradient only

The vertex binding restriction now admits texture and sampler bindings, and the
vertex stage lowers `sample_l` (`textureSampleLevel`) and `sample_d`
(`textureSampleGrad`). Implicit-LOD `sample`/`sample_b` stay fragment-only —
WGSL forbids implicit derivatives in a vertex entry point.

## Not supported (fail closed)

- **Globally non-refactorable shaders** (`dcl_global_flags` without
  `REFACTORING_ALLOWED`) — every operation would be precise; see the Adapted
  entry for why per-op precise is representable but this is not.
- **DX12 bindless sampled-resource ranges** (`space1` arrays/unbounded
  ranges) — comparison-only limitation by the 2026-07-20 target decision
  (DX11 is the target; DX12 exists to confirm equal results). Needs its own
  audited design if it ever becomes target work.
- **`imul`/`umul` high-half results** — WGSL has no 32×32→64 multiply
  builtin; only the low-half destination is supported.
- **Dynamic constant-buffer register selection** (`cbX[dynamic][…]` selecting
  the *buffer*) — only the vector index may be dynamic.
- **Non-immediate mip levels in `resinfo`/`ld`**, and both are bounded to 2D
  textures (below).
- **Unknown texture dimensions** (`texturecubearray`, MSAA kinds, …) in
  sampled layouts.
- **Relative `indexable_temp` SSA, subroutine control flow
  (`call`/`callc`/`label`/`interface_call`)** — front-end rejections.
- **Sampler modes other than `default`**, non-`linear` fragment input
  interpolation, minimum-precision operands, and vertex system semantics
  outside `SV_Position`/`SV_VertexID`/`SV_InstanceID` (fragment:
  `SV_Position`/`SV_IsFrontFace`, output `SV_Target`).

### sample_d gradient sampling + integer/rounding opcode fill-out

`sample_d` lowers to `textureSampleGrad(t, s, coord, ddx, ddy)` (2/3-component
gradients by dimension). Added `imax/imin/umax/umin` (WGSL overloaded
`max`/`min`), `ishl`/`ishr` (`<< u32(...)` / `>> u32(...)` — DXBC shift counts
cast to the WGSL-required u32), `round_pi` (`ceil`), and the previously
handler-only `ult`/`uge` to both stage support sets.

## Bounded / temporary

- **`resinfo`** — 2D textures, immediate mip, components x/y (dimensions) and
  w (`textureNumLevels`); z (depth/array size) rejected for 2D. Widen per
  dimension when a shader needs it.
- **`ld`** — 2D textures, address layout xy=texel/z=mip, u32 coordinates.
- **`ld_structured`** — fixed immediate DWORD byte offsets, one scalar
  address, fixed (non-relative) resource operands.
- **`f16tof32`/`f32tof16`** — per-lane `unpack2x16float`/`pack2x16float`;
  `f32tof16` keeps only the low 16 bits (DXBC contract).
- **Loop merges** — scalar phis with exactly one entry and one backedge
  incoming; multi-exit loops (several `break` sites feeding distinct post-loop
  merges) are untested beyond the single-breakc corpus shape.
- **Loop-exit (break-join) merges** — a DXBC loop exited only through `break`
  edges yields phis at the after-`endloop` join for registers holding different
  values along different break paths. Each scalar phi becomes a `var` declared
  before the loop and assigned before every `break` with that break block's true
  reaching value (from `block.outputValues`, NOT `incoming.blockId`). Supported
  inputs (fail closed otherwise): an instruction result / program input that
  dominates the break edge, or this loop's own header phi. NOT yet supported: an
  input that is a *nested* phi (e.g. a selection merge inside the loop body) —
  it is declared by another plan, but proving that here needs cross-plan
  declaration tracking. `ui/ubershader(3d)`, `system/shadowdepth`, and
  `specialfx/raymarcher` hit the nested-phi case and fail closed pending that.
- **Switch merges** — break-terminated clauses; at most ONE pass-through
  incoming (a clause that keeps the prior value); a shared-join planner exists
  for `if { switch } endif` joins (fail-closed, currently unexercised by the
  corpus).
- **Selection merges** — scalar phis; two-armed regions identify arm tails by
  edge kind; guaranteed-output tracking intersects arms.
- **`gather4`** — front-end lanes reserved, WGSL emission not yet built.

## Adapted — uniformity

### Derivatives / implicit-LOD samples in non-uniform control flow → `diagnostic(off, derivative_uniformity)`

WGSL forbids screen-space derivatives — the `dpdx*`/`dpdy*` family and the
implicit-LOD samples that derive internally (`textureSample` /
`textureSampleBias`) — inside **non-uniform** control flow (a branch whose
condition can differ between the pixels of a 2x2 quad), because the derivative
compares neighbor pixels that may not all be present. `src/core/wgsl/
uniformity.js` tags each SSA value uniform or varying; when the fragment lowerer
finds one of these operations under a varying-conditioned branch it records
`requiresDerivativeUniformityOptOut` on the program, and `emitWgsl` prepends the
module-level filter `diagnostic(off, derivative_uniformity);` (a standard WGSL
opt-out that Dawn/Tint and Naga both honor — browser-gate confirmed) rather than
rejecting the shader.

Why the directive and not gradient hoisting: the DXBC came from HLSL that relied
on **D3D11's permissive divergent-derivative behavior** (non-participating quad
lanes yield undefined derivatives). The directive reproduces exactly that — the
hardware still computes the implicit derivative in place, so there is no gradient
recomputation. Converting to `textureSampleGrad` with a gradient computed in
uniform control flow (hoisting) would substitute a *different* gradient than the
one D3D11 used, i.e. be less faithful. The directive is emitted only when the
analysis actually detects a non-uniform derivative/sample, and it is visible in
the WGSL (with an explanatory comment) plus flagged on the typed program, so the
reliance on the opt-out is never silent.

Soundness of the trigger: constant-buffer and immediate operands are not SSA
values, so the only varying SEEDS are interpolated fragment inputs (`input[N]`,
incl. `SV_Position`) and per-pixel producers (texture sampling/loading,
derivatives). A value is varying only if it genuinely derives from one of those
— **no false positives**, so the directive is added only where truly needed.
Loops are treated with their enclosing uniformity (a varying `breakc` mid-loop
is not yet modelled; the browser gate remains the backstop for that rare shape).

Corpus: recovers 10 EVE `sm_hi` shaders that WGSL would otherwise reject — the
`stretch` specialfx family (`artillery`, `atomic`, `blast`, `laser`,
`projectile`: `sample_b`/`dpdxCoarse` under a varying branch) plus `bokeh`,
`colorlut_preservealpha`, `digiscramble`, `wormholeerosion`, `expandopaque`
(auto-`sample` gated on a sampled or interpolated value). Browser-gated `laser`,
`bokeh`, `expandopaque` (0 warnings on the real device).

## Verification contract

Every entry above changed under the required `engine-webgpu` browser gate
(real WebGPU device, zero WGSL warnings) in addition to the package suite —
format-level qualification cannot see WGSL scoping/validity. Keep
browser-gating a representative of every new emission feature. Corpus state at
this revision: the complete DX11 unpacked space corpus
(`E:\shaderdiscovery\res\...\managed\space\{spaceobject,turret,decals,
specialfx}`) qualifies CLEAN at `sm_lo`, `sm_hi`, and `sm_depth` — 105/105
shader-tier combinations, zero boundaries.
