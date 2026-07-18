const KIND_ORDER = Object.freeze({
    "uniform-buffer": 0,
    "sampled-resource": 1,
    sampler: 2,
    "storage-resource": 3
});

const KIND_PREFIX = Object.freeze({
    "uniform-buffer": "cb",
    "sampled-resource": "t",
    sampler: "s",
    "storage-resource": "u"
});

function bindingRegister(binding)
{
    return binding.range?.lowerBound ?? binding.registerIndex;
}

function bindingSpace(binding)
{
    return binding.range?.registerSpace ?? 0;
}

function bindingIdentity(binding)
{
    return `${binding.resourceKind}:${binding.registerSpace}:${binding.registerIndex}`;
}

function bindingFingerprint(binding)
{
    return JSON.stringify({
        resourceKind: binding.resourceKind,
        generatedSymbol: binding.generatedSymbol,
        registerSpace: binding.registerSpace,
        registerIndex: binding.registerIndex,
        type: binding.type,
        structureStride: binding.structureStride ?? null,
        buffer: binding.buffer || null,
        texture: binding.texture || null,
        sampler: binding.sampler || null
    });
}

function declarationFor(program, binding)
{
    return program.declarations.find((entry) => entry.dxbcOffset === binding.declarationOffset) || null;
}

function uniformLayout(program, binding)
{
    const declaration = declarationFor(program, binding);
    const sizeInVec4 = declaration?.data?.sizeInVec4;
    if (!Number.isInteger(sizeInVec4) || sizeInVec4 < 1)
    {
        throw new Error(`WGSL uniform ${binding.id} has no positive vec4 size`);
    }
    if (binding.accessPattern !== "immediate_indexed")
    {
        throw new Error(`WGSL uniform ${binding.id} requires unsupported ${binding.accessPattern || "unknown"} indexing`);
    }
    return {
        declaration: `var<uniform>`,
        type: `array<vec4<f32>, ${sizeInVec4}>`,
        buffer: {
            type: "uniform",
            hasDynamicOffset: false,
            minBindingSize: sizeInVec4 * 16
        }
    };
}

function textureLayout(binding)
{
    if (binding.resourceDimension !== "texture2d")
    {
        throw new Error(`WGSL sampled resource ${binding.id} has unsupported dimension ${binding.resourceDimension}`);
    }
    const returns = binding.returnType?.returnTypeNames || [];
    if (returns.length !== 4 || returns.some((entry) => entry !== "float"))
    {
        throw new Error(`WGSL sampled resource ${binding.id} requires a float4 return type`);
    }
    return {
        declaration: "var",
        type: "texture_2d<f32>",
        texture: {
            sampleType: "float",
            viewDimension: "2d",
            multisampled: false
        }
    };
}

function structuredBufferLayout(binding)
{
    const stride = binding.structureStride;
    if (!Number.isInteger(stride) || stride < 4 || stride % 4 !== 0)
    {
        throw new Error(`WGSL structured resource ${binding.id} requires a positive DWORD-aligned stride`);
    }
    if (binding.resourceDimension !== null || binding.returnType !== null)
    {
        throw new Error(`WGSL structured resource ${binding.id} has unexpected typed-resource metadata`);
    }
    return {
        declaration: "var<storage, read>",
        type: "array<u32>",
        structureStride: stride,
        buffer: {
            type: "read-only-storage",
            hasDynamicOffset: false,
            minBindingSize: stride
        }
    };
}

function sampledResourceLayout(binding)
{
    return binding.structureStride === null || binding.structureStride === undefined
        ? textureLayout(binding)
        : structuredBufferLayout(binding);
}

function samplerLayout(program, binding)
{
    const declaration = declarationFor(program, binding);
    const mode = declaration?.data?.samplerModeName;
    if (mode && mode !== "default")
    {
        throw new Error(`WGSL sampler ${binding.id} has unsupported mode ${mode}`);
    }
    return {
        declaration: "var",
        type: "sampler",
        sampler: { type: "filtering" }
    };
}

function lowerOne(program, binding, bindingIndex)
{
    const registerIndex = bindingRegister(binding);
    const registerSpace = bindingSpace(binding);
    if (!Number.isInteger(registerIndex) || !Number.isInteger(registerSpace))
    {
        throw new Error(`WGSL binding ${binding.id} has an unresolved register identity`);
    }
    if (binding.range?.unbounded || binding.range?.registerCount !== 1)
    {
        throw new Error(`WGSL binding ${binding.id} requires an unsupported array or unbounded range`);
    }
    let layout;
    if (binding.resourceKind === "uniform-buffer") layout = uniformLayout(program, binding);
    else if (binding.resourceKind === "sampled-resource") layout = sampledResourceLayout(binding);
    else if (binding.resourceKind === "sampler") layout = samplerLayout(program, binding);
    else throw new Error(`WGSL binding ${binding.id} has unsupported kind ${binding.resourceKind}`);
    return {
        kind: "wgsl-binding",
        id: binding.id,
        resourceKind: binding.resourceKind,
        generatedSymbol: `${KIND_PREFIX[binding.resourceKind]}${registerIndex}${registerSpace ? `_space${registerSpace}` : ""}`,
        registerSpace,
        registerIndex,
        rangeId: binding.range?.rangeId ?? null,
        group: 0,
        binding: bindingIndex,
        visibility: program.stage,
        declarationOffset: binding.declarationOffset,
        ...layout
    };
}

function deepFreeze(value)
{
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const entry of Object.values(value)) deepFreeze(entry);
    return Object.freeze(value);
}

function normalizeBindingPlan(plan)
{
    if (plan === null || plan === undefined) return null;
    if (plan?.format !== "CJS_WGSL_BINDING_PLAN" || plan.formatVersion !== 1 || !Array.isArray(plan.bindings))
    {
        throw new TypeError("WGSL binding plan must be a CJS_WGSL_BINDING_PLAN version 1 document");
    }
    const identities = new Map();
    const slots = new Map();
    for (const entry of plan.bindings)
    {
        const identity = bindingIdentity(entry);
        if (entry.identity !== identity
            || !Number.isInteger(entry.group) || entry.group < 0
            || !Number.isInteger(entry.binding) || entry.binding < 0)
        {
            throw new Error(`WGSL binding plan contains an invalid entry ${entry.identity || identity}`);
        }
        if (identities.has(identity)) throw new Error(`WGSL binding plan contains duplicate identity ${identity}`);
        const slot = `${entry.group}:${entry.binding}`;
        if (slots.has(slot)) throw new Error(`WGSL binding plan assigns ${slot} to multiple identities`);
        identities.set(identity, entry);
        slots.set(slot, identity);
    }
    return identities;
}

/**
 * Converts D3D register declarations to one deterministic WebGPU bind group.
 * Register spaces participate in ordering and identity; SM 5.1 range ids are
 * deliberately not treated as globally unique bindings.
 *
 * @param {object} program Frozen CJS shader IR.
 * @param {object|null} [bindingPlan] Optional pass-global canonical binding plan.
 * @returns {object[]} Frozen WebGPU binding records.
 */
export function lowerBindingLayout(program, bindingPlan = null)
{
    if (program?.format !== "CJS_SHADER_IR") throw new TypeError("WGSL binding lowering expects CJS_SHADER_IR input");
    const planned = normalizeBindingPlan(bindingPlan);
    const sorted = Array.from(program.bindings).sort((left, right) =>
        bindingSpace(left) - bindingSpace(right)
        || (KIND_ORDER[left.resourceKind] ?? 99) - (KIND_ORDER[right.resourceKind] ?? 99)
        || bindingRegister(left) - bindingRegister(right)
        || left.declarationOffset - right.declarationOffset);
    const identities = new Set();
    for (const binding of sorted)
    {
        const identity = `${binding.resourceKind}:${bindingSpace(binding)}:${bindingRegister(binding)}`;
        if (identities.has(identity)) throw new Error(`WGSL binding layout contains duplicate ${identity}`);
        identities.add(identity);
    }
    const lowered = sorted.map((binding, index) => lowerOne(program, binding, index));
    const symbols = new Map();
    for (const binding of lowered)
    {
        const identity = bindingIdentity(binding);
        if (symbols.has(binding.generatedSymbol) && symbols.get(binding.generatedSymbol) !== identity)
        {
            throw new Error(`WGSL binding layout uses ${binding.generatedSymbol} for multiple identities`);
        }
        symbols.set(binding.generatedSymbol, identity);
    }
    if (!planned) return deepFreeze(lowered);
    return deepFreeze(lowered.map((binding) =>
    {
        const identity = bindingIdentity(binding);
        const entry = planned.get(identity);
        if (!entry) throw new Error(`WGSL binding plan does not contain ${identity}`);
        if (bindingFingerprint(entry) !== bindingFingerprint(binding))
        {
            throw new Error(`WGSL binding plan layout for ${identity} does not match the shader declaration`);
        }
        return { ...binding, group: entry.group, binding: entry.binding };
    }));
}
