import { readEffectAnalysis } from "./effectAnalysis.js";
import { buildEffectAnalysis, buildPackage, inspectWithValues } from "./helpers.js";
import { lowerDxbcToIr } from "./ir/lowerDxbcToIr.js";
import { buildWgslBindingPlan } from "./wgsl/buildWgslBindingPlan.js";
import { buildWgsl } from "./wgsl/emitWgsl.js";
import { buildWgslSet } from "./wgsl/buildWgslSet.js";
import {
    buildWgslSelectionMetadata,
    selectEffectStages,
    validateResolvedPermutation
} from "./packageEffectSelection.js";

/**
 * Build one complete CEWGPU package from compiled Tr2 effect bytes.
 *
 * This is the browser-safe whole-effect pipeline used by both live resource
 * conversion and Node orchestration. Filesystem concerns remain in callers.
 *
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} input Compiled effect bytes.
 * @param {object} [options] Source, permutation, and stage-selection policy.
 * @returns {object} Package bytes plus inspection and provenance documents.
 */
export function buildEffectPackage(input, options = {})
{
    const source = normalizeSource(options.source);
    const outputPath = normalizeOptionalString(options.outputPath, "Effect outputPath");
    const permutation = normalizePermutation(options.permutation);
    const selection = normalizeSelection(options.selection);
    const resolved = readEffectAnalysis(input, { source, permutation });

    validateResolvedPermutation(permutation, resolved.selection?.selectedOptions ?? []);

    const analysis = buildEffectAnalysis(resolved, {
        source,
        decodeInstructions: true
    });
    const bytecodeByKey = collectStageBytecode(resolved.effectDescription);
    const selectedStages = selectEffectStages(analysis.stages, selection);
    const irEntries = selectedStages.map((stage) =>
    {
        const bytecode = bytecodeByKey.get(stage.key);

        if (!bytecode?.length)
        {
            throw new Error(`${stage.key} has no shader bytecode`);
        }

        return {
            key: stage.key,
            passKey: `${stage.techniqueName}.pass${stage.passIndex}`,
            ir: lowerDxbcToIr(bytecode, { source: `${source}#${stage.key}` })
        };
    });
    const programsByPass = new Map();

    for (const entry of irEntries)
    {
        if (!programsByPass.has(entry.passKey))
        {
            programsByPass.set(entry.passKey, []);
        }

        programsByPass.get(entry.passKey).push(entry.ir);
    }

    const plans = new Map(Array.from(programsByPass, ([ key, programs ]) => [
        key,
        buildWgslBindingPlan(programs, options.bindingPolicy ?? {})
    ]));
    const shaderEntries = irEntries.map((entry) => ({
        key: entry.key,
        shader: buildWgsl(entry.ir, { bindingPlan: plans.get(entry.passKey) })
    }));
    const wgsl = buildWgslSet(shaderEntries);
    const wgslSelection = buildWgslSelectionMetadata(selection, selectedStages);
    const sourceIdentity = normalizeSourceIdentity(options.sourceIdentity, source, input);
    const info = {
        format: "CEWGPU",
        formatVersion: 1,
        packageKind: "tr2-effect-webgpu",
        sourcePath: source,
        outputPath,
        sourceIdentity,
        translator: "dxbc-js-wgsl",
        stageCount: analysis.stages.length,
        selectedStageCount: selectedStages.length,
        shaderCount: wgsl.shaders.length,
        layoutCount: wgsl.layouts.length
    };
    const metadata = {
        effectName: analysis.effectName,
        sourcePath: source,
        bodyIndex: analysis.bodyIndex,
        selectedOptions: analysis.selectedOptions,
        ...(wgslSelection ? { wgslSelection } : {})
    };
    const bytes = buildPackage([
        [ "INFO", info ],
        [ "META", metadata ],
        [ "ANLS", analysis ],
        [ "WGSL", wgsl ]
    ]);
    const inspection = inspectWithValues(bytes, {
        source,
        emit: "json"
    });
    const qualification = Object.freeze({
        ok: true,
        level: "structural",
        validator: "browser-wgsl-pipeline",
        selectedStageCount: selectedStages.length,
        shaderCount: wgsl.shaders.length,
        layoutCount: wgsl.layouts.length,
        nativeComparison: false
    });

    return Object.freeze({
        bytes,
        info: Object.freeze(info),
        metadata: Object.freeze(metadata),
        analysis,
        wgsl,
        inspection: Object.freeze(inspection),
        qualification
    });
}

function collectStageBytecode(effectDescription)
{
    const bytecodeByKey = new Map();

    for (const technique of effectDescription?.techniques ?? [])
    {
        for (let passIndex = 0; passIndex < technique.passes.length; passIndex++)
        {
            for (const stage of technique.passes[passIndex].stageInputs.filter(Boolean))
            {
                const stageName = stage.cjsShaderBytecode?.stageName;
                const bytes = stage.cjsShaderBytecode?.bytes;

                if (stage.m_exists && stageName && bytes?.length)
                {
                    bytecodeByKey.set(`${technique.name}.pass${passIndex}.${stageName}`, bytes);
                }
            }
        }
    }

    return bytecodeByKey;
}

function normalizeSource(value)
{
    const source = String(value ?? "memory").trim();

    return source || "memory";
}

function normalizeOptionalString(value, name)
{
    if (value === undefined || value === null)
    {
        return null;
    }

    const result = String(value).trim();

    if (!result)
    {
        throw new TypeError(`${name} must be a non-empty string or null`);
    }

    return result;
}

function normalizePermutation(value)
{
    if (value === undefined || value === null)
    {
        return [];
    }

    if (!Array.isArray(value))
    {
        throw new TypeError("Effect permutation policy must be an array");
    }

    return value.map((entry) => Object.freeze({
        name: String(entry?.name ?? ""),
        value: String(entry?.value ?? "")
    }));
}

function normalizeSelection(value)
{
    if (value === undefined || value === null)
    {
        return null;
    }

    if (!value || typeof value !== "object" || Array.isArray(value))
    {
        throw new TypeError("Effect stage selection must be an object");
    }

    const techniqueName = String(value.techniqueName ?? "").trim();
    const passIndex = value.passIndex ?? null;
    const stageNames = value.stageNames ?? [];

    if (!techniqueName)
    {
        throw new TypeError("Effect stage selection requires techniqueName");
    }

    if (passIndex !== null && (!Number.isSafeInteger(passIndex) || passIndex < 0))
    {
        throw new TypeError("Effect stage selection passIndex must be a non-negative integer or null");
    }

    if (!Array.isArray(stageNames)
        || stageNames.some((stageName) => ![ "vertex", "pixel" ].includes(stageName)))
    {
        throw new TypeError("Effect stage selection supports only vertex and pixel stageNames");
    }

    if (stageNames.length && passIndex === null)
    {
        throw new TypeError("Effect stageNames require an exact passIndex");
    }

    return Object.freeze({
        techniqueName,
        passIndex,
        stageNames: Object.freeze([ ...new Set(stageNames) ])
    });
}

function normalizeSourceIdentity(value, source, input)
{
    if (value !== undefined && value !== null
        && (!value || typeof value !== "object" || Array.isArray(value)))
    {
        throw new TypeError("Effect sourceIdentity must be an object");
    }

    const bytes = input instanceof Uint8Array
        ? input
        : input instanceof ArrayBuffer
            ? new Uint8Array(input)
            : ArrayBuffer.isView(input)
                ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
                : null;

    if (!bytes)
    {
        throw new TypeError("Effect input must be Uint8Array, ArrayBuffer, or ArrayBufferView bytes");
    }

    return Object.freeze({
        logicalPath: value?.logicalPath ?? source,
        game: value?.game ?? null,
        client: value?.client ?? null,
        build: value?.build === undefined || value?.build === null ? null : String(value.build),
        byteLength: bytes.byteLength,
        md5: value?.md5 ?? null
    });
}
