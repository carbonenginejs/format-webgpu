import { test } from "node:test";
import assert from "node:assert/strict";

import CjsFormatWebgpu, { CjsFormatWebgpu as NamedCjsFormatWebgpu } from "../src/index.js";
import { buildCewgpuPackage } from "./synthetic.js";

class Package {}
class Resource {}

const SAMPLE_CHUNKS = [
    [ "INFO", { format: "CEWGPU", formatVersion: 1, analyzer: "dxbc-phase1" } ],
    [ "META", { effectName: "quadv5", stages: [] } ],
    [ "ANLS", {
        format: "CEWGPU_ANALYSIS",
        formatVersion: 1,
        stages: [ { key: "Main.pass0.vertex", stageName: "vertex" } ]
    } ]
];

function sampleBytes()
{
    return buildCewgpuPackage(SAMPLE_CHUNKS);
}

test("package root exports one public class", async () =>
{
    const mod = await import("../src/index.js");

    assert.deepEqual(Object.keys(mod).sort(), [ "CjsFormatWebgpu", "default" ]);
    assert.equal(mod.default, CjsFormatWebgpu);
    assert.equal(mod.CjsFormatWebgpu, CjsFormatWebgpu);
    assert.equal(NamedCjsFormatWebgpu, CjsFormatWebgpu);
});

test("reader exposes the expected public profile API", () =>
{
    assert.deepEqual(Object.getOwnPropertyNames(CjsFormatWebgpu.prototype).sort(), [
        "AnalyzeEffect",
        "BuildShaderIr",
        "BuildWgsl",
        "BuildWgslBindingPlan",
        "BuildWgslSet",
        "Build",
        "GetClass",
        "GetValues",
        "HasClass",
        "Inspect",
        "Read",
        "SetClass",
        "SetClasses",
        "SetValues",
        "ToJSON",
        "constructor"
    ].sort());
});

test("reader manages values and classes", () =>
{
    const reader = new CjsFormatWebgpu({
        classes: { Package },
        source: "profile",
        decodeInstructions: false
    }).SetClass("Resource", Resource);

    assert.equal(reader.HasClass("Package"), true);
    assert.equal(reader.HasClass("Resource"), true);
    assert.equal(reader.GetClass("Package"), Package);
    assert.equal(reader.GetValues().emit, CjsFormatWebgpu.OUTPUT_JSON);
    assert.equal(reader.GetValues().source, "profile");
    assert.equal(reader.GetValues().decodeInstructions, false);
});

test("implemented metadata advertises the package surface", () =>
{
    assert.deepEqual(CjsFormatWebgpu.mediaTypes, [ "shader" ]);
    assert.deepEqual(CjsFormatWebgpu.inputTypes, [ "cewgpu" ]);
    assert.deepEqual(CjsFormatWebgpu.outputTypes, [ "json" ]);
    assert.deepEqual(CjsFormatWebgpu.debugOutputTypes, [ "raw" ]);
    assert.equal(CjsFormatWebgpu.implementationStatus, "partial");
    assert.equal(CjsFormatWebgpu.format, "CEWGPU");
    assert.equal(CjsFormatWebgpu.analysisFormat, "CEWGPU_ANALYSIS");
});

test("static read and instance Read share one code path", () =>
{
    const bytes = sampleBytes();
    const fromStatic = CjsFormatWebgpu.read(bytes, { source: "synthetic" });
    const fromInstance = new CjsFormatWebgpu({ source: "synthetic" }).Read(bytes);
    assert.deepEqual(fromStatic, fromInstance);
});

test("json emit parses INFO/META/ANLS chunks and lists stage records", () =>
{
    const result = CjsFormatWebgpu.read(sampleBytes(), { source: "synthetic" });

    assert.equal(result.format, "CEWGPU");
    assert.equal(result.version, 1);
    assert.deepEqual(result.chunks.map((chunk) => chunk.tag), [ "INFO", "META", "ANLS" ]);
    assert.equal(result.info.analyzer, "dxbc-phase1");
    assert.equal(result.metadata.effectName, "quadv5");
    assert.equal(result.analysis.format, "CEWGPU_ANALYSIS");
    assert.equal(result.stages.length, 1);
    assert.equal(result.stages[0].key, "Main.pass0.vertex");
    assert.equal(typeof JSON.stringify(result), "string");
});

test("raw emit exposes the CewgpuPackage instance", () =>
{
    const pkg = CjsFormatWebgpu.read(sampleBytes(), { emit: CjsFormatWebgpu.OUTPUT_RAW });

    assert.equal(pkg.constructor.name, "CewgpuPackage");
    assert.equal(pkg.IsGood(), true);
    assert.equal(pkg.info.formatVersion, 1);
    assert.equal(pkg.metadata.effectName, "quadv5");
    assert.equal(pkg.analysisJson.stages[0].key, "Main.pass0.vertex");
});

test("inspect summarizes without building the full JSON shape", () =>
{
    const summary = CjsFormatWebgpu.inspect(sampleBytes());

    assert.equal(summary.isCewgpu, true);
    assert.equal(summary.version, 1);
    assert.deepEqual(summary.chunks.map((chunk) => chunk.tag), [ "INFO", "META", "ANLS" ]);
    assert.equal(summary.stageCount, 1);
    assert.equal(summary.shaderCount, 0);
    assert.equal("info" in summary, false);
});

test("isCewgpu sniffs the magic and rejects junk", () =>
{
    assert.equal(CjsFormatWebgpu.isCewgpu(sampleBytes()), true);
    assert.equal(CjsFormatWebgpu.isCewgpu(new Uint8Array([ 1, 2, 3 ])), false);
    assert.equal(CjsFormatWebgpu.isCewgpu(new TextEncoder().encode("GARBAGE!")), false);
});

test("Read rejects a payload with a bad magic", () =>
{
    assert.throws(() => CjsFormatWebgpu.read(new TextEncoder().encode("NOPE1234")), /CjsWebgpuReadError|Invalid CEWGPU magic/);
});

test("toJSON converts typed arrays and nested structures", () =>
{
    const converted = CjsFormatWebgpu.toJSON({
        tokens: new Uint32Array([ 1, 2 ]),
        nested: [ { mask: new Uint8Array([ 3 ]) } ]
    });
    assert.deepEqual(converted, { tokens: [ 1, 2 ], nested: [ { mask: [ 3 ] } ] });
});
