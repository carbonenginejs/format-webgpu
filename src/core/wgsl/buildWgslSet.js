const KEY_PATTERN = /^(.*)\.pass([0-9]+)\.(vertex|pixel)$/;
const KEY_STAGE = Object.freeze({ vertex: "vertex", pixel: "fragment" });
const STAGE_TYPES = Object.freeze({ vertex: 0, pixel: 1 });

const VISIBILITY_ORDER = Object.freeze([ "vertex", "fragment", "compute" ]);

function clonePlain(value)
{
    if (Array.isArray(value)) return value.map(clonePlain);
    if (value && typeof value === "object")
    {
        return Object.fromEntries(Object.entries(value).map(([ key, entry ]) => [ key, clonePlain(entry) ]));
    }
    return value;
}

function deepFreeze(value)
{
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const entry of Object.values(value)) deepFreeze(entry);
    return Object.freeze(value);
}

function normalizeEntry(entry, index)
{
    const shader = entry?.shader;
    if (shader?.format !== "CJS_WGSL_SHADER" || shader.formatVersion !== 1
        || typeof shader.code !== "string" || !shader.code
        || typeof shader.entryPoint !== "string" || !shader.entryPoint
        || !Array.isArray(shader.sourceMap)
        || shader.program?.format !== "CJS_TYPED_SHADER")
    {
        throw new TypeError(`WGSL set entry ${index} requires a CJS_WGSL_SHADER descriptor`);
    }
    const key = typeof entry.key === "string" ? entry.key : "";
    const match = KEY_PATTERN.exec(key);
    if (!match || !match[1]) throw new Error(`WGSL set entry ${index} has malformed key ${key || "<empty>"}`);
    const techniqueName = match[1];
    const passIndex = Number(match[2]);
    const stageName = match[3];
    if (shader.stage !== KEY_STAGE[stageName])
    {
        throw new Error(`WGSL set key ${key} does not match shader stage ${shader.stage}`);
    }
    return { shader, stage: shader.stage, techniqueName, passIndex, stageName, stageType: STAGE_TYPES[stageName], key };
}

function portableBinding(binding, visibility)
{
    if (!Number.isInteger(binding.group) || binding.group < 0
        || !Number.isInteger(binding.binding) || binding.binding < 0
        || !Number.isInteger(binding.registerSpace) || binding.registerSpace < 0
        || !Number.isInteger(binding.registerIndex) || binding.registerIndex < 0
        || typeof binding.resourceKind !== "string" || !binding.resourceKind
        || typeof binding.generatedSymbol !== "string" || !binding.generatedSymbol
        || typeof binding.type !== "string" || !binding.type)
    {
        throw new Error(`WGSL binding ${binding.id || binding.generatedSymbol || "unknown"} has an invalid portable identity`);
    }
    const descriptorKeys = [ "buffer", "texture", "sampler" ].filter((key) => binding[key]);
    const expectedDescriptor = {
        "uniform-buffer": "buffer",
        "sampled-resource": "texture",
        sampler: "sampler"
    }[binding.resourceKind];
    if (!expectedDescriptor || descriptorKeys.length !== 1 || descriptorKeys[0] !== expectedDescriptor)
    {
        throw new Error(`WGSL binding ${binding.generatedSymbol} has an invalid ${binding.resourceKind} layout descriptor`);
    }
    return {
        resourceKind: binding.resourceKind,
        generatedSymbol: binding.generatedSymbol,
        registerSpace: binding.registerSpace,
        registerIndex: binding.registerIndex,
        group: binding.group,
        binding: binding.binding,
        visibility: [ visibility ],
        type: binding.type,
        ...(binding.buffer ? { buffer: clonePlain(binding.buffer) } : {}),
        ...(binding.texture ? { texture: clonePlain(binding.texture) } : {}),
        ...(binding.sampler ? { sampler: clonePlain(binding.sampler) } : {})
    };
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
        group: binding.group,
        binding: binding.binding,
        type: binding.type,
        buffer: binding.buffer || null,
        texture: binding.texture || null,
        sampler: binding.sampler || null
    });
}

function buildLayouts(entries)
{
    const passes = new Map();
    for (const entry of entries)
    {
        const passKey = `${entry.techniqueName}.pass${entry.passIndex}`;
        if (!passes.has(passKey)) passes.set(passKey, { identities: new Map(), slots: new Map() });
        const pass = passes.get(passKey);
        const symbols = new Map();
        for (const source of entry.shader.program.bindings || [])
        {
            const binding = portableBinding(source, entry.stage);
            const identity = bindingIdentity(binding);
            if (symbols.has(binding.generatedSymbol) && symbols.get(binding.generatedSymbol) !== identity)
            {
                throw new Error(`WGSL shader ${entry.key} uses ${binding.generatedSymbol} for multiple D3D identities`);
            }
            symbols.set(binding.generatedSymbol, identity);
            const slot = `${binding.group}:${binding.binding}`;
            const existingSlot = pass.slots.get(slot);
            if (existingSlot && existingSlot !== identity)
            {
                throw new Error(`WGSL set ${passKey} assigns ${slot} to both ${existingSlot} and ${identity}`);
            }
            pass.slots.set(slot, identity);
            const existing = pass.identities.get(identity);
            if (!existing)
            {
                pass.identities.set(identity, binding);
                continue;
            }
            if (bindingFingerprint(existing) !== bindingFingerprint(binding))
            {
                throw new Error(`WGSL set ${passKey} has conflicting layouts for ${identity}`);
            }
            existing.visibility = Array.from(new Set([ ...existing.visibility, ...binding.visibility ]))
                .sort((left, right) => VISIBILITY_ORDER.indexOf(left) - VISIBILITY_ORDER.indexOf(right));
        }
    }
    return Array.from(passes, ([ key, pass ]) =>
    {
        const groups = new Map();
        for (const binding of pass.identities.values())
        {
            if (!groups.has(binding.group)) groups.set(binding.group, []);
            groups.get(binding.group).push(binding);
        }
        return {
            key,
            techniqueName: key.slice(0, key.lastIndexOf(".pass")),
            passIndex: Number(/\.pass([0-9]+)$/.exec(key)?.[1]),
            bindGroups: Array.from(groups, ([ group, bindings ]) => ({
                group,
                bindings: bindings.sort((left, right) => left.binding - right.binding)
            })).sort((left, right) => left.group - right.group)
        };
    }).sort((left, right) =>
        left.techniqueName.localeCompare(right.techniqueName)
        || left.passIndex - right.passIndex);
}

/**
 * Builds the portable JSON document stored in a CEWGPU `WGSL` chunk.
 * Existing numeric bindings are validated and never reassigned.
 *
 * @param {Array<object>} input Wrapped emitted shader descriptors.
 * @returns {object} Frozen CJS_WGSL_SET document.
 */
export function buildWgslSet(input)
{
    if (!Array.isArray(input) || !input.length) throw new TypeError("BuildWgslSet expects a non-empty shader entry array");
    const entries = input.map(normalizeEntry);
    const keys = new Set();
    const shaders = entries.map((entry) =>
    {
        if (keys.has(entry.key)) throw new Error(`WGSL set contains duplicate shader key ${entry.key}`);
        keys.add(entry.key);
        return {
            key: entry.key,
            techniqueName: entry.techniqueName,
            passIndex: entry.passIndex,
            stageName: entry.stageName,
            stage: entry.stage,
            stageType: entry.stageType,
            entryPoint: entry.shader.entryPoint,
            code: entry.shader.code,
            sourceMap: clonePlain(entry.shader.sourceMap || [])
        };
    }).sort((left, right) =>
        left.techniqueName.localeCompare(right.techniqueName)
        || left.passIndex - right.passIndex
        || [ "vertex", "pixel" ].indexOf(left.stageName) - [ "vertex", "pixel" ].indexOf(right.stageName));
    return deepFreeze({
        format: "CJS_WGSL_SET",
        formatVersion: 1,
        shaders,
        layouts: buildLayouts(entries)
    });
}
