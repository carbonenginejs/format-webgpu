import { resolve } from "node:path";

const STAGE_NAMES = new Set([ "vertex", "pixel" ]);
const PERMUTATION_PATTERN = /^([^=\s]+)=([^=\s]+)$/u;

function requireValue(args, index, flag)
{
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
}

function parsePermutationValue(value)
{
    const match = PERMUTATION_PATTERN.exec(value);
    if (!match)
    {
        throw new Error("--permutation requires an exact NAME=VALUE pair without whitespace");
    }
    return Object.freeze({ name: match[1], value: match[2] });
}

/**
 * Parse the strict package-effect command line without silently dropping an
 * invalid selector.
 *
 * @param {string[]} args Command-line arguments after node/script.
 * @returns {object} Parsed input/output and optional selection.
 */
export function parsePackageEffectArguments(args)
{
    const positionals = [];
    let techniqueName = null;
    let passIndex = null;
    const stageNames = [];
    const permutation = [];
    const permutationNames = new Set();
    for (let index = 0; index < args.length; index += 1)
    {
        const argument = args[index];
        if (argument === "--technique")
        {
            if (techniqueName !== null) throw new Error("--technique may only be specified once");
            techniqueName = requireValue(args, index, argument);
            index += 1;
        }
        else if (argument === "--pass")
        {
            if (passIndex !== null) throw new Error("--pass may only be specified once");
            const value = requireValue(args, index, argument);
            if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error("--pass requires a non-negative integer");
            passIndex = Number(value);
            index += 1;
        }
        else if (argument === "--stage")
        {
            const value = requireValue(args, index, argument);
            if (!STAGE_NAMES.has(value)) throw new Error(`--stage does not support ${value}`);
            if (stageNames.includes(value)) throw new Error(`--stage ${value} is duplicated`);
            stageNames.push(value);
            index += 1;
        }
        else if (argument === "--permutation")
        {
            const entry = parsePermutationValue(requireValue(args, index, argument));
            if (permutationNames.has(entry.name))
            {
                throw new Error(`--permutation duplicates axis ${entry.name}`);
            }
            permutationNames.add(entry.name);
            permutation.push(entry);
            index += 1;
        }
        else if (argument.startsWith("-"))
        {
            throw new Error(`Unknown package-effect option ${argument}`);
        }
        else
        {
            positionals.push(argument);
        }
    }
    if (positionals.length !== 2)
    {
        throw new Error("Usage: node scripts/package-effect.js <input.sm_*> <output.cewgpu> [--permutation NAME=VALUE ...] [--technique <name> [--pass <index> [--stage vertex --stage pixel]]]");
    }
    if (passIndex !== null && techniqueName === null) throw new Error("--pass requires --technique");
    if (stageNames.length && (techniqueName === null || passIndex === null))
    {
        throw new Error("--stage requires --technique and --pass");
    }
    const selection = techniqueName === null ? null : Object.freeze({
        techniqueName,
        passIndex,
        stageNames: Object.freeze(stageNames)
    });
    return Object.freeze({
        inputArgument: positionals[0],
        outputArgument: positionals[1],
        permutation: Object.freeze(permutation),
        selection
    });
}

/**
 * Verify that the format reader resolved every explicit CLI permutation
 * exactly. The underlying effect reader intentionally falls back to defaults
 * for unknown names/values, which is unsafe for reproducible packaging.
 *
 * @param {object[]} requested Requested NAME=VALUE records.
 * @param {object[]} selectedOptions Resolved ANLS selectedOptions records.
 * @returns {true} True when every request resolved exactly.
 */
export function validateResolvedPermutation(requested, selectedOptions)
{
    if (!Array.isArray(requested) || !Array.isArray(selectedOptions))
    {
        throw new TypeError("Package effect permutation validation requires requested and selected option arrays");
    }
    const requestedNames = new Set();
    const selectedByName = new Map();
    for (const entry of selectedOptions)
    {
        if (typeof entry?.name !== "string" || !entry.name || selectedByName.has(entry.name))
        {
            throw new Error("Package effect selectedOptions are malformed or duplicated");
        }
        selectedByName.set(entry.name, entry);
    }
    for (const entry of requested)
    {
        if (typeof entry?.name !== "string" || !entry.name || typeof entry.value !== "string" || !entry.value)
        {
            throw new Error("Package effect requested permutation is malformed");
        }
        if (requestedNames.has(entry.name))
        {
            throw new Error(`Package effect requested permutation duplicates axis ${entry.name}`);
        }
        requestedNames.add(entry.name);
        const resolved = selectedByName.get(entry.name);
        if (!resolved)
        {
            throw new Error(`Unknown effect permutation axis ${entry.name}`);
        }
        if (resolved.value !== entry.value)
        {
            throw new Error(
                `Effect permutation ${entry.name} requested ${entry.value} but resolved ${resolved.value}`
            );
        }
    }
    return true;
}

/**
 * Prevent a package output from replacing its compiled-effect input.
 *
 * @param {string} inputPath Resolved or relative input path.
 * @param {string} outputPath Resolved or relative output path.
 * @param {string} [platform] Platform used for path comparison.
 * @returns {true} True when the paths are distinct.
 */
export function validatePackageEffectPaths(inputPath, outputPath, platform = process.platform)
{
    const normalize = (value) =>
    {
        const path = resolve(value);
        return platform === "win32" ? path.toLowerCase() : path;
    };
    if (normalize(inputPath) === normalize(outputPath))
    {
        throw new Error("Package effect output must not overwrite the input effect file");
    }
    return true;
}

/**
 * Prove that ANLS metadata and the separately resolved bytecode body use the
 * same mixed-radix selection before any shader bytes are packaged.
 *
 * @param {object} analysis Full effect analysis.
 * @param {object} selection Bytecode reader selection.
 * @returns {true} True when both resolutions are identical.
 */
export function validateMatchingEffectResolution(analysis, selection)
{
    if (!analysis || !selection || analysis.bodyIndex !== selection.bodyIndex)
    {
        throw new Error("Package effect analysis and bytecode body indices do not match");
    }
    const compact = (entries) => (Array.isArray(entries) ? entries : []).map((entry) => ({
        name: entry?.name,
        value: entry?.value,
        optionIndex: entry?.optionIndex
    }));
    if (JSON.stringify(compact(analysis.selectedOptions)) !== JSON.stringify(compact(selection.selectedOptions)))
    {
        throw new Error("Package effect analysis and bytecode selections do not match");
    }
    return true;
}

function validateStageRecords(stages)
{
    if (!Array.isArray(stages)) throw new TypeError("Package effect analysis stages must be an array");
    const keys = new Set();
    for (const [ index, stage ] of stages.entries())
    {
        const expected = `${stage?.techniqueName}.pass${stage?.passIndex}.${stage?.stageName}`;
        if (!stage || typeof stage.techniqueName !== "string" || !stage.techniqueName
            || !Number.isInteger(stage.passIndex) || stage.passIndex < 0
            || !STAGE_NAMES.has(stage.stageName) || stage.key !== expected)
        {
            throw new Error(`Package effect analysis stage ${index} is malformed`);
        }
        if (keys.has(stage.key)) throw new Error(`Package effect analysis contains duplicate stage ${stage.key}`);
        keys.add(stage.key);
    }
}

/**
 * Select complete analysis stages for WGSL emission. ANLS itself remains full.
 *
 * @param {object[]} stages Complete ANLS stage list.
 * @param {object|null} selection Parsed selection.
 * @returns {object[]} Selected stage records in ANLS order.
 */
export function selectPackageEffectStages(stages, selection)
{
    validateStageRecords(stages);
    if (!selection) return stages.slice();
    const techniqueStages = stages.filter((stage) => stage.techniqueName === selection.techniqueName);
    if (!techniqueStages.length) throw new Error(`Unknown effect technique ${selection.techniqueName}`);
    const selected = selection.passIndex === null
        ? techniqueStages
        : techniqueStages.filter((stage) => stage.passIndex === selection.passIndex);
    if (!selected.length)
    {
        throw new Error(`Unknown effect pass ${selection.techniqueName}.pass${selection.passIndex}`);
    }
    if (selection.stageNames.length)
    {
        const requested = new Set(selection.stageNames);
        const actual = new Set(selected.map((stage) => stage.stageName));
        const missing = selection.stageNames.filter((stageName) => !actual.has(stageName));
        const unexpected = Array.from(actual).filter((stageName) => !requested.has(stageName));
        if (missing.length || unexpected.length)
        {
            throw new Error(
                `Stage assertion for ${selection.techniqueName}.pass${selection.passIndex} is incomplete: ` +
                `missing ${missing.join(",") || "none"}; unlisted ${unexpected.join(",") || "none"}`
            );
        }
    }
    return selected;
}

/**
 * Build explicit selection provenance for META, or null for legacy packaging.
 *
 * @param {object|null} selection Parsed selection.
 * @param {object[]} selectedStages Selected ANLS stage records.
 * @returns {object|null} Selection metadata.
 */
export function buildWgslSelectionMetadata(selection, selectedStages)
{
    if (!selection) return null;
    const selectedStageNames = Array.from(new Set(selectedStages.map((stage) => stage.stageName)));
    return {
        mode: "explicit",
        completePasses: true,
        techniqueName: selection.techniqueName,
        passIndex: selection.passIndex,
        requestedStageNames: selection.stageNames.length ? selectedStageNames : [],
        selectedStageKeys: selectedStages.map((stage) => stage.key)
    };
}
