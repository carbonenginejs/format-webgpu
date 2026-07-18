import { lowerBindingLayout } from "./lowerBindingLayout.js";

const KIND_ORDER = Object.freeze({
    "uniform-buffer": 0,
    "sampled-resource": 1,
    sampler: 2,
    "storage-resource": 3
});

function identity(binding)
{
    return `${binding.resourceKind}:${binding.registerSpace}:${binding.registerIndex}`;
}

function portableBinding(binding)
{
    return {
        identity: identity(binding),
        resourceKind: binding.resourceKind,
        generatedSymbol: binding.generatedSymbol,
        registerSpace: binding.registerSpace,
        registerIndex: binding.registerIndex,
        type: binding.type,
        ...(Number.isInteger(binding.structureStride) ? { structureStride: binding.structureStride } : {}),
        ...(binding.buffer ? { buffer: binding.buffer } : {}),
        ...(binding.texture ? { texture: binding.texture } : {}),
        ...(binding.sampler ? { sampler: binding.sampler } : {})
    };
}

function fingerprint(binding)
{
    return JSON.stringify(portableBinding(binding));
}

function deepFreeze(value)
{
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const entry of Object.values(value)) deepFreeze(entry);
    return Object.freeze(value);
}

/**
 * Builds one deterministic numeric binding plan shared by all shader stages in
 * a pass. Callers feed the returned plan back into BuildWgsl for every stage.
 *
 * @param {object[]} programs CJS shader IR programs from one effect pass.
 * @param {object} [options] Explicit pass-level identity policy.
 * @param {string[]} [options.sharedIdentities] D3D identities confirmed by
 * pass metadata/CjsLibrary to represent one resource across stages.
 * @returns {object} Frozen pass-global binding plan.
 */
export function buildWgslBindingPlan(programs, options = {})
{
    if (!Array.isArray(programs) || !programs.length)
    {
        throw new TypeError("BuildWgslBindingPlan expects at least one CJS shader IR program");
    }
    const sharedIdentities = new Set(options.sharedIdentities || []);
    if (![ ...sharedIdentities ].every((entry) => typeof entry === "string" && /^(uniform-buffer|sampled-resource|sampler|storage-resource):\d+:\d+$/u.test(entry)))
    {
        throw new TypeError("BuildWgslBindingPlan sharedIdentities must contain D3D resource identities");
    }
    const identities = new Map();
    for (const [ index, program ] of programs.entries())
    {
        if (program?.format !== "CJS_SHADER_IR")
        {
            throw new TypeError(`BuildWgslBindingPlan program ${index} is not CJS_SHADER_IR`);
        }
        for (const binding of lowerBindingLayout(program))
        {
            const key = identity(binding);
            const entry = portableBinding(binding);
            const existing = identities.get(key);
            if (existing && fingerprint(existing.binding) !== fingerprint(entry))
            {
                throw new Error(`WGSL pass binding ${key} has incompatible stage declarations`);
            }
            if (existing && !sharedIdentities.has(key))
            {
                throw new Error(`WGSL pass binding ${key} appears in multiple stages without an explicit shared identity`);
            }
            if (!existing) identities.set(key, { binding: entry, programIndex: index });
        }
    }
    const bindings = Array.from(identities.values(), (entry) => entry.binding)
        .sort((left, right) =>
            left.registerSpace - right.registerSpace
            || (KIND_ORDER[left.resourceKind] ?? 99) - (KIND_ORDER[right.resourceKind] ?? 99)
            || left.registerIndex - right.registerIndex
            || left.generatedSymbol.localeCompare(right.generatedSymbol))
        .map((binding, bindingIndex) => ({ ...binding, group: 0, binding: bindingIndex }));
    return deepFreeze({
        format: "CJS_WGSL_BINDING_PLAN",
        formatVersion: 1,
        ...(sharedIdentities.size ? { sharedIdentities: Object.freeze([ ...sharedIdentities ].sort()) } : {}),
        bindings
    });
}
