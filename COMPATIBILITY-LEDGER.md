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
projections, and per-lane `movc` selects.

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
- **`continue`/`continuec` in loops** — the loop phi-update placement assumes
  fall-through to the latch; `continuing {}`-based support is designable when
  a shader needs it.
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
- **Switch merges** — break-terminated clauses; at most ONE pass-through
  incoming (a clause that keeps the prior value); a shared-join planner exists
  for `if { switch } endif` joins (fail-closed, currently unexercised by the
  corpus).
- **Selection merges** — scalar phis; two-armed regions identify arm tails by
  edge kind; guaranteed-output tracking intersects arms.
- **`gather4`** — front-end lanes reserved, WGSL emission not yet built.

## Verification contract

Every entry above changed under the required `engine-webgpu` browser gate
(real WebGPU device, zero WGSL warnings) in addition to the package suite —
format-level qualification cannot see WGSL scoping/validity. Keep
browser-gating a representative of every new emission feature. Corpus state at
this revision: the complete DX11 unpacked space corpus
(`E:\shaderdiscovery\res\...\managed\space\{spaceobject,turret,decals,
specialfx}`) qualifies CLEAN at `sm_lo`, `sm_hi`, and `sm_depth` — 105/105
shader-tier combinations, zero boundaries.
