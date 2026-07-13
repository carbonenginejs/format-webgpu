import { test } from "node:test";
import assert from "node:assert/strict";

import CjsFormatWebgpu from "../src/index.js";
import { buildEffectAnalysis } from "../src/core/helpers.js";
import { buildCewgpuPackage, buildEffectBytes, buildMinimalVertexDxbc } from "./synthetic.js";

test("static build and instance Build share one code path", () =>
{
    const chunks = [
        [ "INFO", { format: "CEWGPU", formatVersion: 1, stageCount: 1 } ],
        [ "META", { effectName: "quadv5", stages: [] } ]
    ];

    const fromStatic = CjsFormatWebgpu.build(chunks);
    const fromInstance = new CjsFormatWebgpu().Build(chunks);
    assert.deepEqual(Array.from(fromStatic), Array.from(fromInstance));
});

test("Build assembles a package that Read parses back with matching chunk tags/JSON", () =>
{
    const bytes = CjsFormatWebgpu.build([
        [ "INFO", { format: "CEWGPU", formatVersion: 1, stageCount: 1 } ],
        [ "META", { effectName: "quadv5", stages: [ { techniqueName: "Main" } ] } ],
        [ "ANLS", {
            format: "CEWGPU_ANALYSIS",
            formatVersion: 1,
            stages: [
                { key: "Main.pass0.vertex", stageName: "vertex" }
            ]
        } ]
    ]);

    const result = CjsFormatWebgpu.read(bytes, { source: "quadv5.cewgpu" });

    assert.equal(result.format, "CEWGPU");
    assert.equal(result.version, 1);
    assert.equal(result.sourcePath, "quadv5.cewgpu");
    assert.deepEqual(result.chunks.map((chunk) => chunk.tag), [ "INFO", "META", "ANLS" ]);
    assert.equal(result.info.stageCount, 1);
    assert.equal(result.metadata.effectName, "quadv5");
    assert.equal(result.analysis.format, "CEWGPU_ANALYSIS");
    assert.equal(result.stages.length, 1);

    const summary = CjsFormatWebgpu.inspect(bytes);
    assert.equal(summary.version, 1);
    assert.equal(summary.stageCount, 1);
    assert.equal(summary.shaderCount, 0);
});

test("Build accepts string and raw-byte chunk payloads", () =>
{
    const bytes = CjsFormatWebgpu.build([
        [ "INFO", { format: "CEWGPU", formatVersion: 1 } ],
        [ "WGSL", "@vertex fn main() -> @builtin(position) vec4f { return vec4f(); }\n" ],
        [ "BLOB", Uint8Array.from([ 0x01, 0x02, 0x03, 0x04 ]) ]
    ]);

    const raw = CjsFormatWebgpu.read(bytes, { emit: CjsFormatWebgpu.OUTPUT_RAW });
    assert.match(raw.wgsl, /@vertex fn main/);
    assert.equal(raw.wgslJson, null);
    assert.equal(raw.GetChunk("BLOB").bytes[0], 0x01);

    const json = CjsFormatWebgpu.read(bytes);
    assert.match(json.wgsl, /@vertex fn main/);
    assert.deepEqual(json.shaders, []);
});

test("WGSL JSON exposes optional pass-level canonical layouts", () =>
{
    const layout = {
        key: "Main.pass0",
        bindGroups: [ {
            group: 0,
            bindings: [ {
                resourceKind: "uniform-buffer",
                generatedSymbol: "cb0",
                registerSpace: 0,
                registerIndex: 0,
                group: 0,
                binding: 0,
                visibility: [ "fragment" ],
                buffer: { type: "uniform", hasDynamicOffset: false, minBindingSize: 48 }
            } ]
        } ]
    };
    const bytes = CjsFormatWebgpu.build([ [ "WGSL", {
        format: "CJS_WGSL_SET",
        formatVersion: 1,
        shaders: [],
        layouts: [ layout ]
    } ] ]);

    const result = CjsFormatWebgpu.read(bytes);
    assert.deepEqual(result.layouts, [ layout ]);
    assert.equal(CjsFormatWebgpu.inspect(bytes).layoutCount, 1);
});

test("buildCewgpuPackage cross-checks against CewgpuPackageBuilder's own encoding", () =>
{
    const chunks = [ [ "INFO", { a: 1 } ], [ "META", { b: 2 } ] ];
    const viaBuilder = CjsFormatWebgpu.build(chunks);
    const viaRawHelper = buildCewgpuPackage(chunks);
    assert.deepEqual(Array.from(viaBuilder), Array.from(viaRawHelper));
});

test("Read rejects an unsupported CEWGPU version", () =>
{
    const bytes = buildCewgpuPackage([]);
    const view = new DataView(bytes.buffer);
    view.setUint32("CWGP".length, 99, true);
    assert.throws(() => CjsFormatWebgpu.read(bytes), /Unsupported CEWGPU version 99/);
});

test("AnalyzeEffect reports selected permutation information even when the body cannot decode", () =>
{
    const bytes = buildEffectBytes({
        permutations: [
            {
                name: "QUALITY",
                description: "Quality selector",
                defaultOption: 0,
                options: [ "LOW", "HIGH" ]
            }
        ],
        bodies: [ { size: 0 }, { size: 0 } ]
    });

    const analysis = CjsFormatWebgpu.analyzeEffect(bytes, {
        source: "synthetic.sm_hi",
        permutation: [ { name: "QUALITY", value: "HIGH" } ]
    });

    assert.equal(analysis.format, "CEWGPU_ANALYSIS");
    assert.equal(analysis.source, "synthetic.sm_hi");
    assert.equal(analysis.bodyIndex, 1);
    assert.deepEqual(analysis.selectedOptions.map((entry) => [ entry.name, entry.value, entry.source ]), [
        [ "QUALITY", "HIGH", "local" ]
    ]);
    assert.deepEqual(analysis.stages, []);
});

test("buildEffectAnalysis normalizes manifest stages and decodes DXBC", () =>
{
    const dxbc = buildMinimalVertexDxbc();

    const analysis = buildEffectAnalysis({
        effectRes: {
            sourcePath: "synthetic.sm_hi",
            m_version: 8,
            m_compilerVersion: null
        },
        selection: {
            bodyIndex: 0,
            selectedOptions: []
        },
        effectDescription: {
            version: 8,
            effectName: "fixture"
        },
        bindingManifest: {
            toJSON()
            {
                return {
                    effectName: "fixture",
                    version: 8,
                    passes: [ {
                        techniqueName: "Main",
                        passIndex: 0,
                        renderStates: 0,
                        states: []
                    } ],
                    stages: [ {
                        techniqueName: "Main",
                        passIndex: 0,
                        stageType: 0,
                        stageName: "vertex",
                        shaderHandle: 12,
                        shaderBytecode: {
                            stageType: 0,
                            stageName: "vertex",
                            shaderSize: dxbc.length,
                            stringTableOffset: 0,
                            effectName: "fixture",
                            bytes: Array.from(dxbc)
                        },
                        pipelineInputs: [ { usage: "POSITION", registerIndex: 0 } ],
                        threadGroupSize: null,
                        bindings: []
                    } ]
                };
            }
        }
    }, {
        source: "synthetic.sm_hi",
        decodeInstructions: false
    });

    assert.equal(analysis.format, "CEWGPU_ANALYSIS");
    assert.equal(analysis.effectName, "fixture");
    assert.equal(analysis.passes.length, 1);
    assert.equal(analysis.stages.length, 1);
    assert.equal(analysis.stages[0].key, "Main.pass0.vertex");
    assert.equal(analysis.stages[0].dxbc.program.programTypeName, "vertex");
    assert.equal(analysis.stages[0].dxbc.instructions, null);
    assert.equal(analysis.stages[0].dxbcError, null);
    assert.equal(analysis.stages[0].ir, null);
    assert.equal(analysis.stages[0].irError, null);

    const withIr = buildEffectAnalysis({
        effectRes: { m_version: 8, m_compilerVersion: 1 },
        effectDescription: { version: 8, effectName: "fixture" },
        selection: { bodyIndex: 0, selectedOptions: [] },
        bindingManifest: {
            toJSON()
            {
                return {
                    effectName: "fixture",
                    version: 8,
                    passes: [],
                    stages: [ {
                        techniqueName: "Main",
                        passIndex: 0,
                        stageType: 0,
                        stageName: "vertex",
                        shaderBytecode: { bytes: Array.from(dxbc) },
                        bindings: []
                    } ]
                };
            }
        }
    }, { source: "synthetic.sm_hi", decodeInstructions: true });
    assert.equal(withIr.stages[0].ir.format, "CJS_SHADER_IR");
    assert.equal(withIr.stages[0].ir.stage, "vertex");
    assert.equal(withIr.stages[0].irError, null);
});
