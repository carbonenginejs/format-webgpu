import CjsFormatDxbc from "@carbonenginejs/format-dxbc";
import { readEffectAnalysis } from "./effectAnalysis.js";

import { CewgpuPackage } from "./cewgpu/CewgpuPackage.js";
import { CewgpuPackageBuilder } from "./cewgpu/CewgpuPackageBuilder.js";
import { CjsWebgpuReadError } from "./errors.js";
import { lowerDxbcToIr } from "./ir/lowerDxbcToIr.js";

export const OUTPUT_JSON = "json";
export const OUTPUT_RAW = "raw";
export const CEWGPU_MAGIC = "CWGP";
export const CEWGPU_FORMAT = "CEWGPU";
export const CEWGPU_ANALYSIS_FORMAT = "CEWGPU_ANALYSIS";
export const CEWGPU_ANALYSIS_VERSION = 1;

export const DEFAULT_VALUES = Object.freeze({
    emit: OUTPUT_JSON,
    source: "memory",
    decodeInstructions: true,
    permutation: null,
    schema: null,
    classes: Object.freeze({})
});

const OPTION_KEYS = new Set([ "emit", "source", "decodeInstructions", "permutation", "schema", "classes" ]);
const VALID_EMITS = new Set([ OUTPUT_JSON, OUTPUT_RAW ]);

function hasOwn(value, key)
{
    return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeEmit(emit, readerName)
{
    if (emit === undefined || emit === OUTPUT_JSON) return OUTPUT_JSON;
    if (emit === OUTPUT_RAW) return OUTPUT_RAW;
    throw new TypeError(`${readerName}: emit must be "${OUTPUT_JSON}" or "${OUTPUT_RAW}", got ${JSON.stringify(emit)}`);
}

function assertKnownOptions(options, readerName)
{
    for (const key of Object.keys(options))
    {
        if (!OPTION_KEYS.has(key))
        {
            throw new TypeError(`${readerName}: unknown option ${JSON.stringify(key)}`);
        }
    }
}

function classMap(values)
{
    return values && values.classes ? values.classes : {};
}

function cloneValues(values)
{
    return {
        emit: values.emit,
        source: values.source ?? DEFAULT_VALUES.source,
        decodeInstructions: values.decodeInstructions ?? DEFAULT_VALUES.decodeInstructions,
        permutation: values.permutation ?? null,
        schema: values.schema ?? null,
        classes: { ...classMap(values) }
    };
}

export function validateClassKey(classKeys, key, readerName)
{
    if (!classKeys.includes(key))
    {
        throw new Error(`${readerName} unknown class type "${String(key)}"`);
    }
}

export function validateClass(classKeys, type, Class, readerName)
{
    validateClassKey(classKeys, type, readerName);
    if (typeof Class !== "function")
    {
        throw new TypeError(`${readerName} class "${type}" must be a constructor`);
    }
}

function mergeClasses(values, classes, classKeys, readerName)
{
    if (!classes || typeof classes !== "object")
    {
        throw new TypeError(`${readerName} classes option must be an object`);
    }

    const next = { ...values.classes };
    for (const [ type, Class ] of Object.entries(classes))
    {
        validateClass(classKeys, type, Class, readerName);
        next[type] = Class;
    }
    values.classes = next;
}

/**
 * Merge format values over a base set and validate them.
 *
 * @param {object} base Current values.
 * @param {object} [options] Values to merge in.
 * @param {string[]} classKeys Valid class keys.
 * @param {string} readerName Reader name used in error messages.
 * @returns {object} A validated copy of the merged values.
 */
export function normalizeValues(base, options = {}, classKeys = [], readerName = "CjsFormatWebgpu")
{
    if (!options || typeof options !== "object")
    {
        throw new TypeError(`${readerName} options must be an object`);
    }

    assertKnownOptions(options, readerName);

    const values = cloneValues(base);
    if (hasOwn(options, "emit")) values.emit = normalizeEmit(options.emit, readerName);
    if (hasOwn(options, "source")) values.source = typeof options.source === "string" && options.source ? options.source : DEFAULT_VALUES.source;
    if (hasOwn(options, "decodeInstructions")) values.decodeInstructions = !!options.decodeInstructions;
    if (hasOwn(options, "permutation")) values.permutation = options.permutation ?? null;
    if (hasOwn(options, "schema")) values.schema = options.schema ?? null;
    if (hasOwn(options, "classes")) mergeClasses(values, options.classes, classKeys, readerName);
    return values;
}

/**
 * Normalize caller input into a Uint8Array of package bytes.
 *
 * @param {Uint8Array|ArrayBuffer|Buffer|DataView} input Candidate payload.
 * @returns {Uint8Array} The payload bytes.
 */
export function toBytes(input)
{
    if (input instanceof Uint8Array) return input;
    if (typeof ArrayBuffer !== "undefined" && input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new TypeError("CjsFormatWebgpu: input must be CEWGPU package bytes (Uint8Array, Buffer, DataView or ArrayBuffer)");
}

/**
 * Sniffs whether a payload starts with the CEWGPU container magic.
 *
 * @param {Uint8Array|ArrayBuffer|Buffer|DataView} input Candidate payload.
 * @returns {boolean} True when the payload looks like a CEWGPU package.
 */
export function isCewgpu(input)
{
    try
    {
        const bytes = toBytes(input);
        return bytes.length >= CEWGPU_MAGIC.length
            && CEWGPU_MAGIC.split("").every((char, index) => bytes[index] === char.charCodeAt(0));
    }
    catch
    {
        return false;
    }
}

/**
 * The shared read path used by the instance Read/Inspect and static one-shots.
 *
 * @param {Uint8Array|ArrayBuffer|Buffer|DataView} input CEWGPU package payload.
 * @param {object} values Normalized format values.
 * @returns {CewgpuPackage} The loaded package.
 */
export function readRaw(input, values)
{
    const bytes = toBytes(input);
    const pkg = new CewgpuPackage();
    const ok = pkg.Read(bytes, { sourcePath: values.source });

    if (!ok)
    {
        throw new CjsWebgpuReadError(
            pkg.readError ? pkg.readError.message : "Failed to read CEWGPU package",
            {
                source: values.source,
                cause: pkg.readError || null
            }
        );
    }

    return pkg;
}

function analysisStages(pkg)
{
    const analysisJson = pkg.analysisJson;
    return Array.isArray(analysisJson?.stages) ? analysisJson.stages : [];
}

function wgslShaders(pkg)
{
    const wgslJson = pkg.wgslJson;
    return Array.isArray(wgslJson?.shaders) ? wgslJson.shaders : [];
}

function wgslLayouts(pkg)
{
    const wgslJson = pkg.wgslJson;
    return Array.isArray(wgslJson?.layouts) ? wgslJson.layouts : [];
}

/**
 * Converts a loaded package to the documented plain JSON shape.
 *
 * @param {CewgpuPackage} pkg Loaded package.
 * @returns {object} Plain JSON data.
 */
export function packageToJson(pkg)
{
    return toJsonValue({
        format: CEWGPU_FORMAT,
        version: pkg.version,
        sourcePath: pkg.sourcePath,
        chunks: pkg.chunks.map(({ tag, size, offset }) => ({ tag, size, offset })),
        info: pkg.info,
        metadata: pkg.metadata,
        analysis: pkg.analysisJson !== null ? pkg.analysisJson : pkg.analysis,
        wgsl: pkg.wgslJson !== null ? pkg.wgslJson : pkg.wgsl,
        stages: analysisStages(pkg),
        shaders: wgslShaders(pkg),
        layouts: wgslLayouts(pkg)
    });
}

/**
 * Shared read entry honouring the emit mode.
 *
 * @param {Uint8Array|ArrayBuffer|Buffer|DataView} input CEWGPU package payload.
 * @param {object} values Normalized format values.
 * @returns {CewgpuPackage|object} Raw package or plain JSON package data.
 */
export function readWithValues(input, values)
{
    const pkg = readRaw(input, values);
    return values.emit === OUTPUT_RAW ? pkg : packageToJson(pkg);
}

/**
 * Cheap inspection: version, chunk tags/sizes, analysis-stage counts, and
 * WGSL shader counts without building the full JSON package shape.
 *
 * @param {Uint8Array|ArrayBuffer|Buffer|DataView} input CEWGPU package payload.
 * @param {object} values Normalized format values.
 * @returns {object} Plain summary data.
 */
export function inspectWithValues(input, values)
{
    const pkg = readRaw(input, values);
    return {
        source: values.source,
        isCewgpu: true,
        version: pkg.version,
        chunks: pkg.chunks.map(({ tag, size, offset }) => ({ tag, size, offset })),
        stageCount: analysisStages(pkg).length,
        shaderCount: wgslShaders(pkg).length,
        layoutCount: wgslLayouts(pkg).length
    };
}

/**
 * Assembles a CEWGPU package from ordered chunk payloads.
 *
 * @param {Array<[string, string|object|Uint8Array|ArrayBuffer|ArrayBufferView]>} chunks Ordered package chunks.
 * @returns {Uint8Array} Package bytes.
 */
export function buildPackage(chunks)
{
    return CewgpuPackageBuilder.build(chunks);
}

function dxbcSource(source, key)
{
    return source ? `${source}#${key}` : key;
}

function analyzeStage(stage, options)
{
    const key = `${stage.techniqueName}.pass${stage.passIndex}.${stage.stageName}`;
    const out = {
        ...stage,
        key,
        dxbc: null,
        dxbcError: null,
        ir: null,
        irError: null
    };

    const bytecodeBytes = stage.shaderBytecode?.bytes;
    if (!Array.isArray(bytecodeBytes) || bytecodeBytes.length === 0)
    {
        return out;
    }

    try
    {
        out.dxbc = CjsFormatDxbc.read(Uint8Array.from(bytecodeBytes), {
            source: dxbcSource(options.source, key),
            decodeInstructions: options.decodeInstructions
        });
        if (options.decodeInstructions && Array.isArray(out.dxbc.instructions))
        {
            try
            {
                out.ir = lowerDxbcToIr(out.dxbc, { source: dxbcSource(options.source, key) });
            }
            catch (error)
            {
                out.irError = {
                    name: error.name,
                    message: error.message
                };
            }
        }
    }
    catch (error)
    {
        out.dxbcError = {
            name: error.name,
            message: error.message
        };
    }

    return out;
}

/**
 * Builds the normalized WebGPU analysis document from a resolved effect.
 *
 * @param {object} resolved Raw resolved-effect context from `readEffectAnalysis`.
 * @param {object} [options] Analysis options.
 * @param {string} [options.source] Source label for diagnostics.
 * @param {boolean} [options.decodeInstructions] Whether DXBC instructions are decoded.
 * @returns {object} Plain JSON-compatible analysis data.
 */
export function buildEffectAnalysis(resolved, options = {})
{
    const source = options.source || resolved.effectRes?.sourcePath || "memory";
    const decodeInstructions = options.decodeInstructions !== undefined ? !!options.decodeInstructions : true;
    const manifest = resolved.bindingManifest?.toJSON?.() ?? null;
    const stages = (manifest?.stages || []).map((stage) => analyzeStage(stage, { source, decodeInstructions }));

    return toJsonValue({
        format: CEWGPU_ANALYSIS_FORMAT,
        formatVersion: CEWGPU_ANALYSIS_VERSION,
        source,
        effectVersion: resolved.effectDescription?.version ?? manifest?.version ?? resolved.effectRes?.m_version ?? null,
        compilerVersion: resolved.effectRes?.m_compilerVersion ?? null,
        effectName: manifest?.effectName || resolved.effectDescription?.effectName || null,
        bodyIndex: resolved.selection?.bodyIndex ?? 0,
        selectedOptions: resolved.selection?.selectedOptions ?? [],
        passes: manifest?.passes || [],
        stages
    });
}

/**
 * Analyzes one compiled effect payload into a normalized WebGPU-facing
 * document: selected permutation, Carbon binding manifest, and per-stage DXBC
 * decode.
 *
 * @param {Uint8Array|ArrayBuffer|Buffer|DataView} input Tr2 effect payload.
 * @param {object} values Normalized format values.
 * @returns {object} Plain JSON-compatible analysis data.
 */
export function analyzeEffectWithValues(input, values)
{
    const resolved = readEffectAnalysis(input, {
        source: values.source,
        permutation: values.permutation
    });

    return buildEffectAnalysis(resolved, {
        source: values.source,
        decodeInstructions: values.decodeInstructions
    });
}

/**
 * Deep-convert a value to plain JSON-compatible data.
 *
 * @param {any} value Value to convert.
 * @returns {any} Plain data.
 */
export function toJsonValue(value)
{
    if (value === null || value === undefined) return value ?? null;
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return value.toString();
    if (ArrayBuffer.isView(value)) return Array.from(value);
    if (Array.isArray(value)) return value.map(toJsonValue);
    if (value instanceof Map)
    {
        const out = {};
        for (const [ key, entry ] of value) out[key] = toJsonValue(entry);
        return out;
    }
    if (value instanceof Set) return Array.from(value, toJsonValue);
    if (typeof value === "object")
    {
        if (typeof value.toJSON === "function") return toJsonValue(value.toJSON());
        const out = {};
        for (const key of Object.keys(value)) out[key] = toJsonValue(value[key]);
        return out;
    }
    return null;
}

export { CjsWebgpuReadError };
