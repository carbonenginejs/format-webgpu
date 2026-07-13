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
    else if (binding.resourceKind === "sampled-resource") layout = textureLayout(binding);
    else if (binding.resourceKind === "sampler") layout = samplerLayout(program, binding);
    else throw new Error(`WGSL binding ${binding.id} has unsupported kind ${binding.resourceKind}`);
    return {
        kind: "wgsl-binding",
        id: binding.id,
        resourceKind: binding.resourceKind,
        generatedSymbol: `${KIND_PREFIX[binding.resourceKind]}${registerIndex}`,
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

/**
 * Converts D3D register declarations to one deterministic WebGPU bind group.
 * Register spaces participate in ordering and identity; SM 5.1 range ids are
 * deliberately not treated as globally unique bindings.
 *
 * @param {object} program Frozen CJS shader IR.
 * @returns {object[]} Frozen WebGPU binding records.
 */
export function lowerBindingLayout(program)
{
    if (program?.format !== "CJS_SHADER_IR") throw new TypeError("WGSL binding lowering expects CJS_SHADER_IR input");
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
    return deepFreeze(sorted.map((binding, index) => lowerOne(program, binding, index)));
}
