import { readEffectAnalysis } from "./effectAnalysis.js";
import { buildEffectAnalysis, buildPackage, inspectWithValues } from "./helpers.js";
import { lowerDxbcToIr } from "./ir/lowerDxbcToIr.js";
import { buildWgslBindingPlan } from "./wgsl/buildWgslBindingPlan.js";
import { buildWgsl } from "./wgsl/emitWgsl.js";
import { buildWgslSet } from "./wgsl/buildWgslSet.js";
import { buildResourceTransformPlan } from "./wgsl/buildResourceTransformPlan.js";
import {
    isParticleClearEffectCandidate,
    particleClearEffectProofFor,
    preflightParticleClearEffectProfile
} from "./wgsl/lowerParticleClearComputePrograms.js";
import {
    buildWgslSelectionMetadata,
    normalizeEffectPermutation,
    selectEffectStages,
    validateResolvedPermutation
} from "./packageEffectSelection.js";

/**
 * Build one structurally valid selected-body CEWGPU package from compiled
 * Tr2 effect bytes.
 *
 * This browser-safe path resolves one effect body and emits complete passes
 * within the requested stage selection. Filesystem concerns remain in callers.
 *
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} input Compiled effect bytes.
 * @param {object} [options] Source, body-mode, permutation, and stage-selection policy.
 * @returns {object} Package bytes plus inspection and provenance documents.
 */
export function buildEffectPackage(input, options = {})
{
    const mode = normalizeMode(options.mode, options.allPermutations);
    const source = normalizeSource(options.source);
    const outputPath = normalizeOptionalString(options.outputPath, "Effect outputPath");
    const permutation = normalizeEffectPermutation(options.permutation);
    const selection = normalizeSelection(options.selection);
    const resolved = readEffectAnalysis(input, { source, permutation });

    validateResolvedPermutation(permutation, resolved.selection?.selectedOptions ?? []);

    const analysis = buildEffectAnalysis(resolved, {
        source,
        decodeBytecode: false,
        decodeInstructions: false
    });
    const bytecodeByKey = resolved.stageBytecodeByKey;
    const selectedStages = selectEffectStages(analysis.stages, selection);
    const programsByKey = new Map();
    const programForKey = (key) =>
    {
        if (programsByKey.has(key)) return programsByKey.get(key);
        const bytecode = bytecodeByKey.get(key)?.bytes;

        if (!bytecode?.length)
        {
            throw new Error(`${key} has no shader bytecode`);
        }
        const program = lowerDxbcToIr(
            bytecode,
            { source: `${source}#${key}` }
        );
        programsByKey.set(key, program);
        return program;
    };
    let effectProfileContext = null;
    if (isParticleClearEffectCandidate(resolved.effectDescription))
    {
        programForKey("Main.pass0.compute");
        programForKey("Main.pass1.compute");
        effectProfileContext = preflightParticleClearEffectProfile(
            resolved.effectDescription,
            programsByKey
        );
    }
    const irEntries = selectedStages.map((stage) => ({
        key: stage.key,
        passKey: `${stage.techniqueName}.pass${stage.passIndex}`,
        ir: programForKey(stage.key),
        semanticBindings: analysis.stages.find((candidate) =>
            candidate.techniqueName === stage.techniqueName
            && candidate.passIndex === stage.passIndex
            && candidate.stageName === stage.stageName)?.bindings || [],
        effectProfileProof: particleClearEffectProofFor(
            effectProfileContext,
            stage.key
        )
    }));
    const programsByPass = new Map();

    for (const entry of irEntries)
    {
        if (!programsByPass.has(entry.passKey))
        {
            programsByPass.set(entry.passKey, []);
        }

        programsByPass.get(entry.passKey).push(entry);
    }

    const resourceTransformPlans = new Map(Array.from(programsByPass, ([ key, entries ]) => [
        key,
        buildResourceTransformPlan(
            entries.map((entry) => ({
                ir: entry.ir,
                semanticBindings: entry.semanticBindings
            })),
            { layoutKey: key }
        )
    ]));
    const plans = new Map(Array.from(programsByPass, ([ key, entries ]) =>
    {
        const proof = entries.find((entry) => entry.effectProfileProof)
            ?.effectProfileProof ?? null;
        const resourceTransformPlan = resourceTransformPlans.get(key);
        return [
            key,
            buildWgslBindingPlan(
                entries.map((entry) => entry.ir),
                {
                    ...(options.bindingPolicy ?? {}),
                    ...(proof ? { effectProfileProof: proof } : {}),
                    ...(resourceTransformPlan ? { resourceTransformPlan } : {})
                }
            )
        ];
    }));
    const shaderEntries = irEntries.map((entry) => ({
        key: entry.key,
        shader: buildWgsl(entry.ir, {
            bindingPlan: plans.get(entry.passKey),
            ...(resourceTransformPlans.get(entry.passKey)
                ? { resourceTransformPlan: resourceTransformPlans.get(entry.passKey) }
                : {}),
            ...(entry.effectProfileProof
                ? { effectProfileProof: entry.effectProfileProof }
                : {})
        })
    }));
    const wgsl = buildWgslSet(shaderEntries);
    const wgslSelection = buildWgslSelectionMetadata(selection, selectedStages);
    const sourceIdentity = normalizeSourceIdentity(options.sourceIdentity, source, input);
    const completeness = Object.freeze({
        packageValid: true,
        sourceComplete: false,
        backendComplete: false,
        runtimeComplete: false
    });
    const info = {
        format: "CEWGPU",
        formatVersion: 1,
        packageKind: "tr2-effect-webgpu",
        sourcePath: source,
        outputPath,
        sourceIdentity,
        translator: "dxbc-js-wgsl",
        bodyMode: mode,
        completeness,
        stageCount: analysis.stages.length,
        selectedStageCount: selectedStages.length,
        shaderCount: wgsl.shaders.length,
        layoutCount: wgsl.layouts.length
    };
    const metadata = {
        effectName: analysis.effectName,
        sourcePath: source,
        bodyMode: mode,
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
        validator: "cewgpu-structural",
        mode,
        ...completeness,
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

function normalizeMode(value, allPermutations)
{
    if (allPermutations !== undefined && typeof allPermutations !== "boolean")
    {
        throw new TypeError("Effect allPermutations compatibility option must be boolean");
    }

    const mode = String(allPermutations === true ? "all" : value ?? "selected").trim();

    if (mode !== "selected")
    {
        throw new Error(
            `Effect package mode ${mode || "<empty>"} is not supported; `
            + "all-body packaging requires portable complete effect reflection"
        );
    }

    return mode;
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
        || stageNames.some((stageName) => ![ "vertex", "pixel", "compute" ].includes(stageName)))
    {
        throw new TypeError("Effect stage selection supports only vertex, pixel, and compute stageNames");
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
