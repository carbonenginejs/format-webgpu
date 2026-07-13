import CjsFormatHlsl, * as Hlsl from "@carbonenginejs/format-hlsl";

function normalizeSelections(values, source)
{
    if (values instanceof Map)
    {
        return Array.from(values, ([ name, value ]) => ({ name, value, source }));
    }
    if (!Array.isArray(values)) return [];
    return values.map((entry) => ({
        name: entry?.name || "",
        value: entry?.value || "",
        source
    }));
}

function resolveSelection(effectRes, permutation)
{
    const local = normalizeSelections(permutation, "local");
    const global = normalizeSelections(effectRes.constructor.globalEffectOptions || [], "global");
    const selectedOptions = [];
    let bodyIndex = 0;
    let multiplier = 1;

    for (const axis of effectRes.m_permutations || [])
    {
        let optionIndex = axis.defaultOption;
        let source = "default";
        const selected = global.find((entry) => entry.name === axis.name)
            || local.find((entry) => entry.name === axis.name);
        if (selected)
        {
            const index = axis.options.findIndex((value) => value === selected.value);
            if (index >= 0)
            {
                optionIndex = index;
                source = selected.source;
            }
        }
        selectedOptions.push({
            name: axis.name,
            value: axis.options[optionIndex] ?? null,
            optionIndex,
            defaultOption: axis.defaultOption,
            defaultValue: axis.options[axis.defaultOption] ?? null,
            source
        });
        bodyIndex += optionIndex * multiplier;
        multiplier *= axis.options.length || 1;
    }
    return { bodyIndex, selectedOptions };
}

function readEffectAnalysisCompat(input, options)
{
    const permutation = options.permutation ?? [];
    const effectRes = CjsFormatHlsl.read(input, {
        emit: "raw",
        source: options.source,
        permutation
    });
    const selection = resolveSelection(effectRes, permutation);
    let shader = null;
    try
    {
        shader = effectRes.GetShader(permutation);
    }
    catch
    {
        shader = null;
    }
    const effectDescription = shader ? shader.GetEffectDescription() : null;
    const bindingManifest = effectDescription
        ? Hlsl.Tr2EffectBindingManifest.fromEffectDescription(effectDescription)
        : null;
    return { effectRes, shader, selection, effectDescription, bindingManifest };
}

/**
 * Resolve one compiled-effect permutation for WebGPU packaging.
 *
 * format-hlsl 0.1.2+ provides the one-shot helper. The compatibility path
 * retains support for the public 0.1.1 raw-reader and binding-manifest surface.
 *
 * @param {Uint8Array|ArrayBuffer|Buffer|DataView} input Tr2 effect bytes.
 * @param {object} [options] Source and permutation options.
 * @returns {object} Resolved raw effect, shader, selection, description, and manifest.
 */
export function readEffectAnalysis(input, options = {})
{
    return typeof Hlsl.readEffectAnalysis === "function"
        ? Hlsl.readEffectAnalysis(input, options)
        : readEffectAnalysisCompat(input, options);
}
