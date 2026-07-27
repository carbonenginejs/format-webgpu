import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import CjsFormatWebgpu from "../src/index.js";
import { buildEffectAnalysis } from "../src/core/helpers.js";
import {
    buildEffectPermutationGraph,
    validateEffectPermutationGraph
} from "../src/core/effectPermutationGraph.js";
import {
    buildCewgpuPackage,
    buildEffectBytes,
    buildMinimalStagedEffectBytes,
    buildMinimalVertexDxbc
} from "./synthetic.js";

function canonicalEffectChunks()
{
    const result = CjsFormatWebgpu.buildEffect(buildMinimalStagedEffectBytes(), {
        source: "synthetic.sm_hi"
    });
    const pkg = CjsFormatWebgpu.read(result.bytes, { emit: CjsFormatWebgpu.OUTPUT_RAW });

    return pkg.chunks.map((chunk) => [ chunk.tag, pkg.GetJson(chunk.tag) ]);
}

function mutateCanonicalEffect(mutations = {}, omitted = [])
{
    const chunks = canonicalEffectChunks()
        .filter(([ tag ]) => !omitted.includes(tag))
        .map(([ tag, value ]) =>
        {
            if (!Object.prototype.hasOwnProperty.call(mutations, tag))
            {
                return [ tag, value ];
            }

            const mutation = mutations[tag];
            if (typeof mutation !== "function") return [ tag, mutation ];
            const copy = structuredClone(value);
            mutation(copy);
            return [ tag, copy ];
        });

    return CjsFormatWebgpu.build(chunks);
}

function uniformLayoutBinding(overrides = {})
{
    return {
        identity: "uniform-buffer:0:0",
        scopeIdentity: "uniform-buffer:0:0@vertex",
        resourceKind: "uniform-buffer",
        generatedSymbol: "cb0",
        registerSpace: 0,
        registerIndex: 0,
        group: 0,
        binding: 0,
        visibility: [ "vertex" ],
        type: "array<vec4<f32>, 1>",
        buffer: {
            type: "uniform",
            hasDynamicOffset: false,
            minBindingSize: 16
        },
        ...overrides
    };
}

function textureLayoutBinding(overrides = {})
{
    return {
        identity: "sampled-resource:0:0",
        scopeIdentity: "sampled-resource:0:0@vertex",
        resourceKind: "sampled-resource",
        generatedSymbol: "t0",
        registerSpace: 0,
        registerIndex: 0,
        group: 0,
        binding: 0,
        visibility: [ "vertex" ],
        type: "texture_2d<f32>",
        texture: {
            sampleType: "float",
            viewDimension: "2d",
            multisampled: false
        },
        ...overrides
    };
}

function samplerCarbon()
{
    return {
        name: null,
        sampler: {
            comparison: false,
            minFilter: 0,
            magFilter: 0,
            mipFilter: 0,
            addressU: 0,
            addressV: 0,
            addressW: 0,
            mipLODBias: 0,
            maxAnisotropy: 1,
            comparisonFunc: 0,
            borderColor: [ 0, 0, 0, 0 ],
            minLOD: 0,
            maxLOD: 0,
            isDynamic: true
        }
    };
}

function signatureSamplerCarbon()
{
    const value = samplerCarbon();
    delete value.sampler.isDynamic;
    value.sampler.borderColor = 0;
    return value;
}

function resourceCarbon(name = "Resource")
{
    return {
        name,
        type: 0,
        arrayElements: 1,
        isSRGB: false,
        isAutoregister: false
    };
}

function analysisBinding(overrides = {})
{
    return {
        kind: "resource",
        generatedSymbol: "t0",
        registerIndex: 0,
        registerType: 36,
        registerSpace: 0,
        registerCount: 1,
        arrayCount: 1,
        dynamic: true,
        metadataName: null,
        carbon: null,
        annotations: [],
        heapView: false,
        sourceTruth: "carbon-stage-register",
        ...overrides
    };
}

test("effect permutation graph preserves mixed-radix variants and body aliases", () =>
{
    const source = Uint8Array.from([
        1, 2, 3,
        1, 2, 3,
        4, 5, 6
    ]);
    const graph = buildEffectPermutationGraph({
        m_data: source,
        m_permutations: [
            {
                name: "A",
                options: [ "A0", "A1" ],
                defaultOption: 1,
                description: "first",
                type: 2
            },
            {
                name: "B",
                options: [ "B0", "B1" ],
                defaultOption: 0,
                description: "second",
                type: 3
            }
        ],
        m_offsetCount: 4,
        m_offsets: [
            { index: 0, offset: 0, size: 3, end: 3 },
            { index: 1, offset: 0, size: 3, end: 3 },
            { index: 2, offset: 3, size: 3, end: 6 },
            { index: 3, offset: 6, size: 3, end: 9 }
        ]
    });

    assert.equal(graph.format, "CJS_EFFECT_PERMUTATION_GRAPH");
    assert.equal(graph.formatVersion, 1);
    assert.deepEqual(graph.variants.map((variant) => variant.optionIndices), [
        [ 0, 0 ],
        [ 1, 0 ],
        [ 0, 1 ],
        [ 1, 1 ]
    ]);
    assert.deepEqual(graph.variants.map((variant) => variant.bodyKey), [
        "body0",
        "body0",
        "body0",
        "body1"
    ]);
    assert.equal(graph.bodies.length, 2);
    assert.equal(
        graph.bodies[0].sha256,
        createHash("sha256").update(Uint8Array.from([ 1, 2, 3 ])).digest("hex")
    );
    assert.equal(
        graph.bodies[1].sha256,
        createHash("sha256").update(Uint8Array.from([ 4, 5, 6 ])).digest("hex")
    );
    assert.deepEqual(validateEffectPermutationGraph(graph), {
        permutationCount: 4,
        uniqueBodyCount: 2
    });

    const wrongIndex = structuredClone(graph);
    wrongIndex.variants[1].permutationIndex = 2;
    assert.throws(
        () => validateEffectPermutationGraph(wrongIndex),
        /variant 1 is malformed/
    );

    const wrongTuple = structuredClone(graph);
    wrongTuple.variants[2].optionIndices = [ 1, 0 ];
    assert.throws(
        () => validateEffectPermutationGraph(wrongTuple),
        /variant 2 is malformed/
    );

    const missingReference = structuredClone(graph);
    missingReference.variants = missingReference.variants.map((variant) => ({
        ...variant,
        bodyKey: "body0"
    }));
    assert.throws(
        () => validateEffectPermutationGraph(missingReference),
        /body body1 is unreferenced/
    );

    const partialOverlap = structuredClone(graph);
    partialOverlap.variants[3].sourceRecord.offset = 5;
    assert.throws(
        () => validateEffectPermutationGraph(partialOverlap),
        /source body records partially overlap/
    );

    assert.throws(
        () => validateEffectPermutationGraph(graph, { sourceByteLength: 8 }),
        /source record is malformed/
    );

    const unsafeSourceRecord = structuredClone(graph);
    unsafeSourceRecord.variants[3].sourceRecord.offset = Number.MAX_SAFE_INTEGER;
    assert.throws(
        () => validateEffectPermutationGraph(unsafeSourceRecord),
        /source record is malformed/
    );

    const duplicateDigest = structuredClone(graph);
    duplicateDigest.bodies[1].sha256 = duplicateDigest.bodies[0].sha256;
    assert.throws(
        () => validateEffectPermutationGraph(duplicateDigest),
        /body 1 is malformed or duplicated/
    );

    const oversizedBody = structuredClone(graph);
    oversizedBody.bodies[1].byteLength = 0x100000000;
    assert.throws(
        () => validateEffectPermutationGraph(oversizedBody),
        /body 1 is malformed/
    );

    const danglingBody = structuredClone(graph);
    danglingBody.variants[3].bodyKey = "missing";
    assert.throws(
        () => validateEffectPermutationGraph(danglingBody),
        /variant 3 is malformed/
    );

    const tooManyAxes = structuredClone(graph);
    tooManyAxes.axes = Array.from({ length: 256 }, (_, index) => ({
        index,
        name: `A${index}`,
        options: [ "ON" ],
        defaultOption: 0,
        description: "",
        type: 0
    }));
    assert.throws(
        () => validateEffectPermutationGraph(tooManyAxes),
        /axes must be an array/
    );

    const tooManyOptions = structuredClone(graph);
    tooManyOptions.axes = [ {
        index: 0,
        name: "A",
        options: Array.from({ length: 256 }, (_, index) => `O${index}`),
        defaultOption: 0,
        description: "",
        type: 0
    } ];
    assert.throws(
        () => validateEffectPermutationGraph(tooManyOptions),
        /axis 0 is malformed/
    );

    const tooManyPermutations = structuredClone(graph);
    tooManyPermutations.axes = [ 41, 40, 40 ].map((count, index) => ({
        index,
        name: `A${index}`,
        options: Array.from({ length: count }, (_, optionIndex) => `O${optionIndex}`),
        defaultOption: 0,
        description: "",
        type: 0
    }));
    assert.throws(
        () => validateEffectPermutationGraph(tooManyPermutations),
        /implementation limit 65536/
    );

    const maximumNativeRange = {
        format: "CJS_EFFECT_PERMUTATION_GRAPH",
        formatVersion: 1,
        coverage: {
            permutations: "complete",
            bodies: "identity-only",
            reflection: "absent"
        },
        axes: [],
        variants: [ {
            permutationIndex: 0,
            optionIndices: [],
            bodyKey: "body0",
            sourceRecord: {
                offset: 0xFFFFFFFF,
                byteLength: 0xFFFFFFFF
            }
        } ],
        bodies: [ {
            key: "body0",
            byteLength: 0xFFFFFFFF,
            sha256: "0".repeat(64)
        } ]
    };
    assert.deepEqual(validateEffectPermutationGraph(maximumNativeRange, {
        sourceByteLength: 0x1FFFFFFFE
    }), {
        permutationCount: 1,
        uniqueBodyCount: 1
    });

    assert.throws(
        () => buildEffectPermutationGraph({
            m_data: source,
            m_permutations: [],
            m_offsetCount: 1,
            m_offsets: [ { index: 7, offset: 0, size: 3, end: 3 } ]
        }),
        /invalid source body record/
    );

    assert.throws(
        () => buildEffectPermutationGraph({
            m_data: source,
            m_permutations: [ {
                name: "A",
                options: [ "A0", "A1" ],
                defaultOption: 0,
                description: "",
                type: 0
            } ],
            m_offsetCount: 2,
            m_offsets: [
                { index: 0, offset: 0, size: 6, end: 6 },
                { index: 1, offset: 3, size: 6, end: 9 }
            ]
        }),
        /source body records partially overlap/
    );
});

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

    assert.doesNotThrow(() => CjsFormatWebgpu.read(CjsFormatWebgpu.build([
        [ "INFO", "generic raw information" ],
        [ "META", "generic metadata" ],
        [ "ANLS", "generic analysis" ],
        [ "WGSL", "generic WGSL" ]
    ]), { emit: CjsFormatWebgpu.OUTPUT_RAW }));
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

test("CEWGPU construction and reading reject ambiguous chunk tags", () =>
{
    assert.throws(
        () => CjsFormatWebgpu.build([
            [ "INFO", {} ],
            [ "INFO", {} ]
        ]),
        /duplicate chunk tag INFO/
    );
    assert.throws(
        () => CjsFormatWebgpu.build([ [ "A\nBC", {} ] ]),
        /four printable ASCII characters/
    );
    assert.throws(
        () => CjsFormatWebgpu.build([ [ "\u0100BCD", {} ] ]),
        /four printable ASCII characters/
    );

    const duplicate = buildCewgpuPackage([
        [ "INFO", { value: 1 } ],
        [ "INFO", { value: 2 } ]
    ]);
    assert.throws(
        () => CjsFormatWebgpu.read(duplicate),
        /duplicate chunk tag INFO/
    );
});

test("CEWGPU reading rejects truncated, trailing, and invalid-tag bytes", () =>
{
    const bytes = CjsFormatWebgpu.build([ [ "INFO", {} ] ]);
    assert.throws(
        () => CjsFormatWebgpu.read(bytes.subarray(0, bytes.length - 1)),
        /Unexpected end|out of bounds|requires/
    );

    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    assert.throws(
        () => CjsFormatWebgpu.read(trailing),
        /trailing bytes/
    );

    const invalidTag = buildCewgpuPackage([ [ "\u0000ABC", {} ] ]);
    assert.throws(
        () => CjsFormatWebgpu.read(invalidTag),
        /four printable ASCII characters/
    );
});

test("canonical effect packages require all versioned JSON documents", () =>
{
    for (const tag of [ "META", "PGRF", "ANLS", "WGSL" ])
    {
        assert.throws(
            () => CjsFormatWebgpu.read(mutateCanonicalEffect({}, [ tag ])),
            new RegExp(`requires ${tag}`)
        );
    }

    const genericWithoutInfo = CjsFormatWebgpu.read(
        mutateCanonicalEffect({}, [ "INFO" ])
    );
    assert.equal(genericWithoutInfo.info, null);
    assert.equal(genericWithoutInfo.shaders.length, 1);

    for (const tag of [ "META", "PGRF", "ANLS", "WGSL" ])
    {
        assert.throws(
            () => CjsFormatWebgpu.read(mutateCanonicalEffect({ [tag]: "{" })),
            new RegExp(`${tag} must contain valid JSON`)
        );
    }

    const invalidVersions = [
        [ "INFO", (value) => { value.formatVersion = 99; }, /INFO schema/ ],
        [ "PGRF", (value) => { value.formatVersion = 99; }, /PGRF schema/ ],
        [ "ANLS", (value) => { value.formatVersion = 99; }, /ANLS schema/ ],
        [ "WGSL", (value) => { value.formatVersion = 99; }, /WGSL schema/ ]
    ];
    for (const [ tag, mutation, pattern ] of invalidVersions)
    {
        assert.throws(
            () => CjsFormatWebgpu.read(mutateCanonicalEffect({ [tag]: mutation })),
            pattern
        );
    }
});

test("canonical effect packages retain legacy INFO version 1 readability", () =>
{
    const bytes = mutateCanonicalEffect({
        INFO: (value) =>
        {
            value.formatVersion = 1;
            delete value.targetBackend;
            delete value.backendPackage;
            delete value.backendPackageVersion;
            delete value.translatorVersion;
            delete value.sourceIdentity.sha256;
            delete value.permutationGraph;
        }
    }, [ "PGRF" ]);

    const result = CjsFormatWebgpu.read(bytes);
    assert.equal(result.info.formatVersion, 1);
    assert.equal(result.info.translator, "dxbc-js-wgsl");
    assert.equal(CjsFormatWebgpu.inspect(bytes).permutationCount, 0);
    assert.equal(CjsFormatWebgpu.inspect(bytes).uniqueBodyCount, 0);
});

test("canonical effect packages retain pre-PGRF INFO version 2 readability", () =>
{
    const bytes = mutateCanonicalEffect({
        INFO: (value) => { delete value.permutationGraph; }
    }, [ "PGRF" ]);

    const result = CjsFormatWebgpu.read(bytes);
    assert.equal(result.info.formatVersion, 2);
    assert.equal(result.permutationGraph, null);
});

test("canonical effect packages reconcile INFO and complete PGRF topology", () =>
{
    const canonical = CjsFormatWebgpu.buildEffect(
        buildMinimalStagedEffectBytes(),
        { source: "synthetic.sm_hi" }
    );
    assert.equal(canonical.info.permutationGraph.chunk, "PGRF");
    assert.equal(canonical.info.permutationGraph.permutationCount, 1);
    assert.equal(canonical.info.permutationGraph.uniqueBodyCount, 1);
    assert.equal(canonical.permutationGraph.variants.length, 1);
    assert.equal(canonical.permutationGraph.bodies.length, 1);

    const parsed = CjsFormatWebgpu.read(canonical.bytes);
    assert.deepEqual(parsed.permutationGraph, canonical.permutationGraph);
    const raw = CjsFormatWebgpu.read(canonical.bytes, {
        emit: CjsFormatWebgpu.OUTPUT_RAW
    });
    assert.deepEqual(raw.permutationGraph, canonical.permutationGraph);

    assert.throws(
        () => CjsFormatWebgpu.read(mutateCanonicalEffect({}, [ "PGRF" ])),
        /permutationGraph requires PGRF/
    );
    assert.throws(
        () => CjsFormatWebgpu.read(mutateCanonicalEffect({
            INFO: (value) => { delete value.permutationGraph; }
        })),
        /INFO\.permutationGraph is malformed/
    );
    assert.throws(
        () => CjsFormatWebgpu.read(mutateCanonicalEffect({
            INFO: (value) => { value.permutationGraph.permutationCount = 2; }
        })),
        /counts disagree/
    );
    for (const [ field, value ] of [
        [ "chunk", "NOPE" ],
        [ "format", "OTHER" ],
        [ "formatVersion", 2 ]
    ])
    {
        assert.throws(
            () => CjsFormatWebgpu.read(mutateCanonicalEffect({
                INFO: (info) => { info.permutationGraph[field] = value; }
            })),
            /INFO\.permutationGraph is malformed/
        );
    }
    assert.throws(
        () => CjsFormatWebgpu.read(mutateCanonicalEffect({
            INFO: (value) => { value.permutationGraph.uniqueBodyCount = 2; }
        })),
        /counts disagree/
    );
    assert.throws(
        () => CjsFormatWebgpu.read(mutateCanonicalEffect({
            PGRF: (value) => { value.variants[0].optionIndices = [ 0 ]; }
        })),
        /variant 0 is malformed/
    );
    assert.throws(
        () => CjsFormatWebgpu.read(mutateCanonicalEffect({
            PGRF: (value) =>
            {
                value.axes.push({
                    index: 0,
                    name: "QUALITY",
                    options: [ "HIGH" ],
                    defaultOption: 0,
                    description: "",
                    type: 0
                });
                value.variants[0].optionIndices = [ 0 ];
            }
        })),
        /selected body is absent from PGRF/
    );
    assert.throws(
        () => CjsFormatWebgpu.read(mutateCanonicalEffect({
            PGRF: (value) => { value.coverage.bodies = "complete"; }
        })),
        /PGRF schema or coverage is unsupported/
    );
    assert.throws(
        () => CjsFormatWebgpu.read(mutateCanonicalEffect({
            PGRF: (value) => { value.bodies[0].sha256 = "A".repeat(64); }
        })),
        /body 0 is malformed/
    );
    assert.throws(
        () => CjsFormatWebgpu.read(mutateCanonicalEffect({
            PGRF: (value) => { value.bodies[0].byteLength += 1; }
        })),
        /body length disagrees/
    );
    assert.throws(
        () => CjsFormatWebgpu.read(mutateCanonicalEffect({
            PGRF: (value) => { value.variants[0].bodyKey = "missing"; }
        })),
        /variant 0 is malformed/
    );
    assert.throws(
        () => CjsFormatWebgpu.read(mutateCanonicalEffect({
            PGRF: (value) => { value.variants[0].sourceRecord.offset += 1; }
        })),
        /source record is malformed/
    );
});

test("multi-axis effect packages reconcile selection and preserve PGRF across stage filtering", () =>
{
    const source = buildMinimalStagedEffectBytes({
        permutations: [
            {
                name: "QUALITY",
                options: [ "LOW", "HIGH" ],
                defaultOption: 0,
                description: "quality",
                type: 1
            },
            {
                name: "MODE",
                options: [ "A", "B", "C" ],
                defaultOption: 1,
                description: "mode",
                type: 2
            }
        ]
    });
    const options = {
        source: "synthetic-multi.sm_hi",
        permutation: [
            { name: "QUALITY", value: "HIGH" },
            { name: "MODE", value: "C" }
        ]
    };
    const complete = CjsFormatWebgpu.buildEffect(source, options);
    const filtered = CjsFormatWebgpu.buildEffect(source, {
        ...options,
        selection: {
            techniqueName: "Main",
            passIndex: 0,
            stageNames: [ "vertex" ]
        }
    });

    assert.equal(complete.metadata.bodyIndex, 5);
    assert.deepEqual(complete.metadata.selectedOptions.map((option) => ({
        name: option.name,
        value: option.value,
        optionIndex: option.optionIndex
    })), [
        { name: "QUALITY", value: "HIGH", optionIndex: 1 },
        { name: "MODE", value: "C", optionIndex: 2 }
    ]);
    assert.equal(complete.permutationGraph.variants.length, 6);
    assert.deepEqual(
        complete.permutationGraph.variants.map((variant) => variant.optionIndices),
        [
            [ 0, 0 ],
            [ 1, 0 ],
            [ 0, 1 ],
            [ 1, 1 ],
            [ 0, 2 ],
            [ 1, 2 ]
        ]
    );
    assert.deepEqual(filtered.permutationGraph, complete.permutationGraph);

    const completeRaw = CjsFormatWebgpu.read(complete.bytes, {
        emit: CjsFormatWebgpu.OUTPUT_RAW
    });
    const filteredRaw = CjsFormatWebgpu.read(filtered.bytes, {
        emit: CjsFormatWebgpu.OUTPUT_RAW
    });
    assert.deepEqual(
        Array.from(filteredRaw.GetChunk("PGRF").bytes),
        Array.from(completeRaw.GetChunk("PGRF").bytes)
    );

    const chunks = completeRaw.chunks.map((chunk) => [
        chunk.tag,
        structuredClone(completeRaw.GetJson(chunk.tag))
    ]);
    const metadata = chunks.find(([ tag ]) => tag === "META")[1];
    const analysis = chunks.find(([ tag ]) => tag === "ANLS")[1];
    metadata.selectedOptions[1].value = "B";
    analysis.selectedOptions[1].value = "B";
    assert.throws(
        () => CjsFormatWebgpu.read(CjsFormatWebgpu.build(chunks)),
        /selected option 1 disagrees with PGRF/
    );
});

test("canonical effect packages accept every binding-manifest source form", () =>
{
    const bindings = [
        analysisBinding(),
        analysisBinding({
            kind: "constantBuffer",
            generatedSymbol: "cb0",
            registerType: 0,
            carbon: {
                hasLocalConstants: false,
                constantValueSize: 0,
                constants: []
            }
        }),
        analysisBinding({
            kind: "sampler",
            generatedSymbol: "s0",
            registerType: 1,
            carbon: signatureSamplerCarbon(),
            sourceTruth: "carbon-signature-sampler"
        }),
        analysisBinding({
            registerType: null,
            carbon: resourceCarbon(""),
            sourceTruth: "carbon-register-map"
        }),
        analysisBinding({
            kind: "sampler",
            generatedSymbol: "s0",
            registerType: null,
            carbon: samplerCarbon(),
            sourceTruth: "carbon-register-map"
        }),
        analysisBinding({
            kind: "uav",
            generatedSymbol: "u0",
            registerType: null,
            carbon: resourceCarbon("Output"),
            sourceTruth: "carbon-register-map"
        })
    ];

    for (const binding of bindings)
    {
        const bytes = mutateCanonicalEffect({
            ANLS: (value) => { value.stages[0].bindings = [ binding ]; }
        });
        assert.equal(CjsFormatWebgpu.read(bytes).analysis.stages[0].bindings.length, 1);
    }
});

test("canonical effect packages reconcile texture descriptors with WGSL types", () =>
{
    const accepted = [
        textureLayoutBinding(),
        textureLayoutBinding({
            type: "texture_2d_array<f32>",
            texture: {
                sampleType: "float",
                viewDimension: "2d-array",
                multisampled: false
            }
        }),
        textureLayoutBinding({
            type: "texture_cube<f32>",
            texture: {
                sampleType: "float",
                viewDimension: "cube",
                multisampled: false
            }
        }),
        textureLayoutBinding({
            type: "texture_3d<f32>",
            texture: {
                sampleType: "float",
                viewDimension: "3d",
                multisampled: false
            }
        })
    ];

    for (const binding of accepted)
    {
        assert.doesNotThrow(() => CjsFormatWebgpu.read(mutateCanonicalEffect({
            WGSL: (value) =>
            {
                value.layouts[0].bindGroups = [ { group: 0, bindings: [ binding ] } ];
            }
        })));
    }

    const rejected = [
        textureLayoutBinding({ type: "texture_cube<f32>" }),
        textureLayoutBinding({
            texture: {
                sampleType: "uint",
                viewDimension: "2d",
                multisampled: false
            }
        }),
        textureLayoutBinding({
            texture: {
                sampleType: "float",
                viewDimension: "2d",
                multisampled: true
            }
        }),
        textureLayoutBinding({ type: "texture_depth_2d" })
    ];

    for (const binding of rejected)
    {
        assert.throws(
            () => CjsFormatWebgpu.read(mutateCanonicalEffect({
                WGSL: (value) =>
                {
                    value.layouts[0].bindGroups = [ { group: 0, bindings: [ binding ] } ];
                }
            })),
            /binding 0 is malformed/
        );
    }
});

test("canonical effect packages reconcile provenance, counts, keys, and selection", () =>
{
    const mutations = [
        {
            chunks: { INFO: (value) => { value.shaderCount += 1; } },
            pattern: /INFO counts/
        },
        {
            chunks: { META: (value) => { value.sourcePath = "other.sm_hi"; } },
            pattern: /source or body mode/
        },
        {
            chunks: { META: (value) => { value.effectName = "other"; } },
            pattern: /effect selection/
        },
        {
            chunks: { META: (value) => { value.bodyIndex += 1; } },
            pattern: /effect selection/
        },
        {
            chunks: { META: (value) => { value.selectedOptions = [ { name: "X", value: "Y" } ]; } },
            pattern: /selectedOptions/
        },
        {
            chunks: {
                INFO: (value) => { delete value.sourcePath; },
                META: (value) => { delete value.sourcePath; },
                ANLS: (value) => { delete value.source; }
            },
            pattern: /INFO\.sourcePath/
        },
        {
            chunks: { INFO: (value) => { delete value.sourceIdentity; } },
            pattern: /INFO\.sourceIdentity/
        },
        {
            chunks: { INFO: (value) => { delete value.translator; } },
            pattern: /INFO\.translator/
        },
        {
            chunks: { INFO: (value) => { delete value.targetBackend; } },
            pattern: /INFO\.targetBackend/
        },
        {
            chunks: { INFO: (value) => { delete value.backendPackage; } },
            pattern: /INFO\.backendPackage/
        },
        {
            chunks: { INFO: (value) => { value.backendPackageVersion = "latest"; } },
            pattern: /INFO\.backendPackage/
        },
        {
            chunks: {
                INFO: (value) =>
                {
                    value.translatorVersion = " ";
                }
            },
            pattern: /INFO\.translator/
        },
        {
            chunks: {
                INFO: (value) => { value.translatorVersion = "1.0.0-01"; }
            },
            pattern: /INFO\.translator/
        },
        {
            chunks: { INFO: (value) => { delete value.sourceIdentity.sha256; } },
            pattern: /INFO\.sourceIdentity/
        },
        {
            chunks: {
                INFO: (value) => { value.sourceIdentity.sha256 = "A".repeat(64); }
            },
            pattern: /INFO\.sourceIdentity/
        },
        {
            chunks: {
                INFO: (value) =>
                {
                    value.sourcePath = "   ";
                    value.sourceIdentity.logicalPath = "   ";
                },
                META: (value) => { value.sourcePath = "   "; },
                ANLS: (value) => { value.source = "   "; }
            },
            pattern: /INFO\.sourcePath/
        },
        {
            chunks: {
                META: (value) => { value.bodyIndex = "zero"; },
                ANLS: (value) => { value.bodyIndex = "zero"; }
            },
            pattern: /META\.bodyIndex/
        },
        {
            chunks: {
                META: (value) => { value.selectedOptions = {}; },
                ANLS: (value) => { value.selectedOptions = {}; }
            },
            pattern: /selectedOptions/
        },
        {
            chunks: {
                META: (value) =>
                {
                    const option = {
                        name: "QUALITY",
                        value: "HIGH",
                        optionIndex: 1,
                        defaultOption: 0,
                        defaultValue: "LOW",
                        source: "local"
                    };
                    value.selectedOptions = [ option, { ...option } ];
                },
                ANLS: (value) =>
                {
                    const option = {
                        name: "QUALITY",
                        value: "HIGH",
                        optionIndex: 1,
                        defaultOption: 0,
                        defaultValue: "LOW",
                        source: "local"
                    };
                    value.selectedOptions = [ option, { ...option } ];
                }
            },
            pattern: /malformed or duplicated/
        },
        {
            chunks: {
                META: (value) =>
                {
                    value.selectedOptions = [ {
                        name: "QUALITY",
                        value: "HIGH",
                        optionIndex: 1,
                        defaultOption: 0,
                        defaultValue: "LOW",
                        source: "default"
                    } ];
                },
                ANLS: (value) =>
                {
                    value.selectedOptions = [ {
                        name: "QUALITY",
                        value: "HIGH",
                        optionIndex: 1,
                        defaultOption: 0,
                        defaultValue: "LOW",
                        source: "default"
                    } ];
                }
            },
            pattern: /malformed or duplicated/
        },
        {
            chunks: {
                META: (value) =>
                {
                    value.selectedOptions = [ {
                        name: "QUALITY",
                        value: "HIGH",
                        optionIndex: 1,
                        defaultOption: 0,
                        source: "local"
                    } ];
                },
                ANLS: (value) =>
                {
                    value.selectedOptions = [ {
                        name: "QUALITY",
                        value: "HIGH",
                        optionIndex: 1,
                        defaultOption: 0,
                        source: "local"
                    } ];
                }
            },
            pattern: /malformed or duplicated/
        },
        {
            chunks: {
                WGSL: (value) =>
                {
                    value.shaders[0].key = "Other.pass0.vertex";
                    value.shaders[0].techniqueName = "Other";
                }
            },
            pattern: /shader absent from ANLS/
        },
        {
            chunks: { WGSL: (value) => { value.shaders[0].stageType = 99; } },
            pattern: /noncanonical key/
        },
        {
            chunks: {
                ANLS: (value) =>
                {
                    value.stages[0].stageName = "toString";
                    value.stages[0].key = "Main.pass0.toString";
                    delete value.stages[0].stageType;
                },
                WGSL: (value) =>
                {
                    value.shaders[0].stageName = "toString";
                    value.shaders[0].key = "Main.pass0.toString";
                    delete value.shaders[0].stage;
                    delete value.shaders[0].stageType;
                }
            },
            pattern: /noncanonical key/
        },
        {
            chunks: {
                INFO: (value) =>
                {
                    value.stageCount += 1;
                    value.selectedStageCount += 1;
                    value.shaderCount += 1;
                },
                ANLS: (value) =>
                {
                    const compute = structuredClone(value.stages[0]);
                    compute.key = "Main.pass0.compute";
                    compute.stageName = "compute";
                    compute.stageType = 2;
                    compute.shaderBytecode.stageName = "compute";
                    compute.shaderBytecode.stageType = 2;
                    value.stages.push(compute);
                },
                WGSL: (value) =>
                {
                    const compute = structuredClone(value.shaders[0]);
                    compute.key = "Main.pass0.compute";
                    compute.stageName = "compute";
                    compute.stage = "compute";
                    compute.stageType = 2;
                    compute.threadGroupSize = [ 1, 1, 1 ];
                    value.shaders.push(compute);
                }
            },
            pattern: /mixes compute and render stages/
        },
        {
            chunks: { WGSL: (value) => { delete value.shaders[0].code; } },
            pattern: /invalid stage metadata/
        },
        {
            chunks: { WGSL: (value) => { value.layouts[0].key = "Other.pass0"; } },
            pattern: /noncanonical key/
        },
        {
            chunks: { WGSL: (value) => { value.layouts[0].passIndex = 1; } },
            pattern: /noncanonical key/
        },
        {
            chunks: {
                META: (value) =>
                {
                    value.wgslSelection = {
                        mode: "explicit",
                        completePasses: true,
                        techniqueName: "Main",
                        passIndex: 0,
                        requestedStageNames: [ "vertex" ],
                        selectedStageKeys: [ "Other.pass0.vertex" ]
                    };
                }
            },
            pattern: /complete ANLS scope/
        },
        {
            chunks: {
                WGSL: (value) =>
                {
                    value.layouts[0].bindGroups = [
                        { group: 1, bindings: [] },
                        { group: 1, bindings: [] }
                    ];
                }
            },
            pattern: /duplicate bind group/
        },
        {
            chunks: {
                WGSL: (value) =>
                {
                    value.layouts[0].bindGroups = [ { group: 1, bindings: [] } ];
                }
            },
            pattern: /contiguous from zero/
        },
        {
            chunks: {
                WGSL: (value) =>
                {
                    const binding = {
                        identity: "uniform-buffer:0:0",
                        scopeIdentity: "uniform-buffer:0:0@vertex",
                        resourceKind: "uniform-buffer",
                        generatedSymbol: "cb0",
                        registerSpace: 0,
                        registerIndex: 0,
                        group: 0,
                        binding: 0,
                        visibility: [ "vertex" ],
                        type: "array<vec4<f32>, 1>",
                        buffer: {
                            type: "uniform",
                            hasDynamicOffset: false,
                            minBindingSize: 16
                        }
                    };
                    value.layouts[0].bindGroups = [ {
                        group: 0,
                        bindings: [ binding, { ...binding } ]
                    } ];
                }
            },
            pattern: /binding 1 is malformed or duplicated/
        },
        {
            chunks: {
                WGSL: (value) =>
                {
                    value.layouts[0].bindGroups = [ {
                        group: 0,
                        bindings: [
                            uniformLayoutBinding(),
                            uniformLayoutBinding({
                                identity: "uniform-buffer:0:1",
                                scopeIdentity: "uniform-buffer:0:1@vertex",
                                registerIndex: 1,
                                binding: 1
                            })
                        ]
                    } ];
                }
            },
            pattern: /duplicates a shader binding symbol/
        },
        {
            chunks: {
                WGSL: (value) =>
                {
                    value.layouts[0].bindGroups = [ {
                        group: 0,
                        bindings: [
                            uniformLayoutBinding(),
                            uniformLayoutBinding({
                                scopeIdentity: "uniform-buffer:0:0",
                                binding: 1,
                                visibility: [ "vertex", "fragment" ],
                                generatedSymbol: "cb0_shared"
                            })
                        ]
                    } ];
                }
            },
            pattern: /mixes shared and stage-scoped bindings/
        },
        {
            chunks: {
                WGSL: (value) =>
                {
                    value.layouts[0].bindGroups = [ {
                        group: 0,
                        bindings: [ {
                            identity: "sampled-resource:0:0",
                            scopeIdentity: "sampled-resource:0:0@vertex",
                            resourceKind: "sampled-resource",
                            generatedSymbol: "t0",
                            registerSpace: 0,
                            registerIndex: 0,
                            group: 0,
                            binding: 0,
                            visibility: [ "vertex" ],
                            type: "sampler",
                            texture: {
                                sampleType: "float",
                                viewDimension: "2d",
                                multisampled: false
                            }
                        } ]
                    } ];
                }
            },
            pattern: /binding 0 is malformed/
        },
        {
            chunks: {
                WGSL: (value) =>
                {
                    const binding = {
                        identity: "uniform-buffer:0:0",
                        scopeIdentity: "uniform-buffer:0:0@vertex",
                        resourceKind: "uniform-buffer",
                        generatedSymbol: "cb0",
                        registerSpace: 0,
                        registerIndex: 0,
                        group: 0,
                        binding: 0,
                        visibility: [ "vertex" ],
                        type: "array<vec4<f32>, 1>",
                        buffer: {
                            type: "uniform",
                            hasDynamicOffset: false,
                            minBindingSize: 16
                        }
                    };
                    value.layouts[0].bindGroups = [ {
                        group: 0,
                        bindings: [
                            binding,
                            { ...binding, binding: 1, generatedSymbol: "cb0_duplicate" }
                        ]
                    } ];
                }
            },
            pattern: /binding 1 is malformed or duplicated/
        },
        {
            chunks: {
                ANLS: (value) =>
                {
                    value.stages[0].shaderBytecode.bytes = [ 1, 2, 3 ];
                }
            },
            pattern: /embeds transient compiler data/
        },
        {
            chunks: { ANLS: (value) => { delete value.passes; } },
            pattern: /ANLS\.passes/
        },
        {
            chunks: { ANLS: (value) => { delete value.effectVersion; } },
            pattern: /effect\/compiler version/
        },
        {
            chunks: { ANLS: (value) => { value.passes[0].states = {}; } },
            pattern: /invalid identity/
        },
        {
            chunks: { ANLS: (value) => { value.passes[0].states = [ null ]; } },
            pattern: /invalid identity/
        },
        {
            chunks: { ANLS: (value) => { value.passes.push({ ...value.passes[0] }); } },
            pattern: /duplicate pass/
        },
        {
            chunks: { ANLS: (value) => { delete value.stages[0].shaderBytecode; } },
            pattern: /transient compiler data/
        },
        {
            chunks: { ANLS: (value) => { delete value.stages[0].bindings; } },
            pattern: /transient compiler data/
        },
        {
            chunks: { ANLS: (value) => { delete value.stages[0].shaderHandle; } },
            pattern: /transient compiler data/
        },
        {
            chunks: { ANLS: (value) => { delete value.stages[0].threadGroupSize; } },
            pattern: /transient compiler data/
        },
        {
            chunks: { ANLS: (value) => { value.stages[0].pipelineInputs = [ null ]; } },
            pattern: /transient compiler data/
        },
        {
            chunks: { ANLS: (value) => { value.stages[0].bindings = [ null ]; } },
            pattern: /transient compiler data/
        },
        {
            chunks: {
                ANLS: (value) =>
                {
                    value.stages[0].bindings = [ analysisBinding({
                        kind: "sampler",
                        generatedSymbol: "s0",
                        registerType: 36
                    }) ];
                }
            },
            pattern: /transient compiler data/
        },
        {
            chunks: {
                ANLS: (value) =>
                {
                    value.stages[0].bindings = [
                        analysisBinding({ registerSpace: 5 }),
                        analysisBinding({
                            registerType: null,
                            carbon: resourceCarbon(),
                            sourceTruth: "carbon-register-map"
                        })
                    ];
                }
            },
            pattern: /transient compiler data/
        },
        {
            chunks: {
                ANLS: (value) =>
                {
                    value.stages[0].bindings = [ analysisBinding({
                        kind: "constantBuffer",
                        generatedSymbol: "cb0",
                        registerType: 0,
                        carbon: {
                            hasLocalConstants: false,
                            constantValueSize: 0,
                            constants: []
                        },
                        heapView: true
                    }) ];
                }
            },
            pattern: /transient compiler data/
        },
        {
            chunks: {
                ANLS: (value) =>
                {
                    value.stages[0].bindings = [ analysisBinding({
                        generatedSymbol: "t1"
                    }) ];
                }
            },
            pattern: /transient compiler data/
        },
        {
            chunks: {
                ANLS: (value) =>
                {
                    value.stages[0].bindings = [ analysisBinding({
                        kind: "sampler",
                        generatedSymbol: "s0",
                        registerType: null,
                        registerCount: 2,
                        arrayCount: 2,
                        carbon: samplerCarbon(),
                        sourceTruth: "carbon-register-map"
                    }) ];
                }
            },
            pattern: /transient compiler data/
        },
        {
            chunks: {
                ANLS: (value) =>
                {
                    value.stages[0].bindings = [ analysisBinding({
                        registerType: 36,
                        carbon: resourceCarbon(),
                        sourceTruth: "carbon-register-map"
                    }) ];
                }
            },
            pattern: /transient compiler data/
        },
        {
            chunks: {
                ANLS: (value) =>
                {
                    value.stages[0].bindings = [ analysisBinding({
                        registerType: null,
                        registerCount: 2,
                        carbon: resourceCarbon(),
                        sourceTruth: "carbon-register-map"
                    }) ];
                }
            },
            pattern: /transient compiler data/
        },
        {
            chunks: {
                ANLS: (value) =>
                {
                    value.stages[0].bindings = [ analysisBinding({
                        kind: "sampler",
                        generatedSymbol: "s0",
                        registerType: 1,
                        carbon: null,
                        sourceTruth: "carbon-signature-sampler"
                    }) ];
                }
            },
            pattern: /transient compiler data/
        },
        {
            chunks: {
                ANLS: (value) =>
                {
                    value.stages[0].bindings = [ analysisBinding({
                        kind: "sampler",
                        generatedSymbol: "s0",
                        registerType: 1,
                        carbon: {},
                        sourceTruth: "carbon-signature-sampler"
                    }) ];
                }
            },
            pattern: /transient compiler data/
        },
        {
            chunks: { WGSL: (value) => { value.formatVersion = 3; } },
            pattern: /version 3 requires resource transforms/
        },
        {
            chunks: {
                WGSL: (value) =>
                {
                    value.resourceTransforms = [ { id: "bogus" } ];
                }
            },
            pattern: /version 2 cannot contain resource transforms/
        },
        {
            chunks: {
                WGSL: (value) =>
                {
                    value.layouts[0].bindGroups = [ {
                        group: 0,
                        bindings: [ {
                            identity: "sampled-resource:0:0",
                            scopeIdentity: "sampled-resource:0:0@vertex",
                            resourceKind: "sampled-resource",
                            generatedSymbol: "t0",
                            registerSpace: 0,
                            registerIndex: 0,
                            group: 0,
                            binding: 0,
                            visibility: [ "vertex" ],
                            type: "texture_2d_array<f32>",
                            transformId: "orphan",
                            arrayLayerCount: 2,
                            texture: {
                                sampleType: "float",
                                viewDimension: "2d-array",
                                multisampled: false
                            }
                        } ]
                    } ];
                }
            },
            pattern: /version 2 cannot contain resource transforms/
        }
    ];

    for (const { chunks, pattern } of mutations)
    {
        assert.throws(
            () => CjsFormatWebgpu.read(mutateCanonicalEffect(chunks)),
            pattern
        );
    }
});

test("canonical explicit selection proves its complete ANLS scope", () =>
{
    const valid = mutateCanonicalEffect({
        META: (value) =>
        {
            value.wgslSelection = {
                mode: "explicit",
                completePasses: true,
                techniqueName: "Main",
                passIndex: 0,
                requestedStageNames: [ "vertex" ],
                selectedStageKeys: [ "Main.pass0.vertex" ]
            };
        }
    });
    assert.equal(CjsFormatWebgpu.read(valid).shaders.length, 1);

    const incomplete = mutateCanonicalEffect({
        INFO: (value) => { value.stageCount += 1; },
        META: (value) =>
        {
            value.wgslSelection = {
                mode: "explicit",
                completePasses: true,
                techniqueName: "Main",
                passIndex: 0,
                requestedStageNames: [ "vertex" ],
                selectedStageKeys: [ "Main.pass0.vertex" ]
            };
        },
        ANLS: (value) =>
        {
            const pixel = structuredClone(value.stages[0]);
            pixel.key = "Main.pass0.pixel";
            pixel.stageName = "pixel";
            pixel.stageType = 1;
            pixel.shaderBytecode.stageName = "pixel";
            pixel.shaderBytecode.stageType = 1;
            value.stages.push(pixel);
        }
    });
    assert.throws(
        () => CjsFormatWebgpu.read(incomplete),
        /complete ANLS scope/
    );

    for (const mutate of [
        (selection) => { selection.techniqueName = "Other"; },
        (selection) => { selection.passIndex = 1; },
        (selection) => { selection.requestedStageNames = [ "pixel" ]; },
        (selection) => { selection.passIndex = null; }
    ])
    {
        assert.throws(
            () => CjsFormatWebgpu.read(mutateCanonicalEffect({
                META: (value) =>
                {
                    value.wgslSelection = {
                        mode: "explicit",
                        completePasses: true,
                        techniqueName: "Main",
                        passIndex: 0,
                        requestedStageNames: [ "vertex" ],
                        selectedStageKeys: [ "Main.pass0.vertex" ]
                    };
                    mutate(value.wgslSelection);
                }
            })),
            /complete ANLS scope/
        );
    }
});

test("AnalyzeEffect resolves exact permutation assertions even when the body cannot decode", () =>
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

    const fromMap = CjsFormatWebgpu.analyzeEffect(bytes, {
        permutation: new Map([ [ "QUALITY", "HIGH" ] ])
    });
    assert.equal(fromMap.bodyIndex, 1);

    const withDefault = CjsFormatWebgpu.analyzeEffect(bytes);
    assert.equal(withDefault.bodyIndex, 0);
    assert.equal(withDefault.selectedOptions[0].value, "LOW");
    assert.equal(withDefault.selectedOptions[0].source, "default");

    assert.throws(
        () => CjsFormatWebgpu.analyzeEffect(bytes, {
            permutation: [ { name: "UNKNOWN", value: "HIGH" } ]
        }),
        /Unknown effect permutation axis UNKNOWN/
    );
    assert.throws(
        () => CjsFormatWebgpu.analyzeEffect(bytes, {
            permutation: [ { name: "QUALITY", value: "INVALID" } ]
        }),
        /requested INVALID but resolved LOW/
    );
    assert.throws(
        () => CjsFormatWebgpu.analyzeEffect(bytes, {
            permutation: [
                { name: "QUALITY", value: "HIGH" },
                { name: "QUALITY", value: "HIGH" }
            ]
        }),
        /duplicates axis QUALITY/
    );
    assert.throws(
        () => CjsFormatWebgpu.analyzeEffect(bytes, {
            permutation: [ { name: "QUALITY", value: 1 } ]
        }),
        /Requested effect permutation is malformed/
    );
    assert.throws(
        () => CjsFormatWebgpu.analyzeEffect(bytes, {
            permutation: { QUALITY: "HIGH" }
        }),
        /must be an array or Map/
    );
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
    assert.equal(analysis.stages[0].shaderBytecode.bytes, undefined);
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
    assert.equal(withIr.stages[0].shaderBytecode.bytes, undefined);
    assert.equal(withIr.stages[0].ir.format, "CJS_SHADER_IR");
    assert.equal(withIr.stages[0].ir.stage, "vertex");
    assert.equal(withIr.stages[0].irError, null);
});

test("buildEffectAnalysis validates transient raw stage identity and bytes", () =>
{
    const dxbc = buildMinimalVertexDxbc();
    const padded = new Uint8Array(dxbc.length + 4);
    padded.set(dxbc, 2);
    const activeBytes = padded.subarray(2, 2 + dxbc.length);
    const manifestStage = {
        techniqueName: "Main",
        passIndex: 0,
        stageType: 0,
        stageName: "vertex",
        shaderBytecode: {
            stageType: 0,
            stageName: "vertex",
            shaderSize: dxbc.length
        },
        bindings: []
    };
    const resolved = {
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
                    stages: [ manifestStage ]
                };
            }
        },
        stageBytecodeByKey: new Map([ [
            "Main.pass0.vertex",
            { stageType: 0, stageName: "vertex", bytes: activeBytes }
        ] ])
    };

    const analysis = buildEffectAnalysis(resolved, { decodeInstructions: false });
    assert.equal(analysis.stages[0].dxbc.program.programTypeName, "vertex");
    assert.equal(analysis.stages[0].shaderBytecode.bytes, undefined);

    const mismatchedType = {
        ...resolved,
        stageBytecodeByKey: new Map([ [
            "Main.pass0.vertex",
            { stageType: 1, stageName: "vertex", bytes: activeBytes }
        ] ])
    };
    assert.throws(
        () => buildEffectAnalysis(mismatchedType),
        /manifest and raw stage metadata disagree/
    );

    const mismatchedName = {
        ...resolved,
        stageBytecodeByKey: new Map([ [
            "Main.pass0.pixel",
            {
                techniqueName: "Main",
                passIndex: 0,
                stageType: 0,
                stageName: "pixel",
                bytes: activeBytes
            }
        ] ])
    };
    assert.throws(
        () => buildEffectAnalysis(mismatchedName),
        /manifest and raw stage metadata disagree/
    );

    const invalidInnerType = {
        ...resolved,
        bindingManifest: {
            toJSON()
            {
                return {
                    effectName: "fixture",
                    version: 8,
                    passes: [],
                    stages: [ {
                        ...manifestStage,
                        shaderBytecode: {
                            ...manifestStage.shaderBytecode,
                            stageType: "0"
                        }
                    } ]
                };
            }
        }
    };
    assert.throws(
        () => buildEffectAnalysis(invalidInnerType),
        /manifest stage bytecode type is invalid/
    );

    const conflictingBytes = {
        ...resolved,
        bindingManifest: {
            toJSON()
            {
                return {
                    effectName: "fixture",
                    version: 8,
                    passes: [],
                    stages: [ {
                        ...manifestStage,
                        shaderBytecode: {
                            ...manifestStage.shaderBytecode,
                            bytes: [ ...dxbc.slice(0, -1), dxbc.at(-1) ^ 0xff ]
                        }
                    } ]
                };
            }
        }
    };
    assert.throws(
        () => buildEffectAnalysis(conflictingBytes),
        /manifest and raw stage bytecode disagree/
    );

    const compactManifestOnly = {
        ...resolved,
        stageBytecodeByKey: null,
        bindingManifest: {
            toJSON()
            {
                return {
                    effectName: "fixture",
                    version: 8,
                    passes: [],
                    stages: [ {
                        ...manifestStage,
                        shaderBytecode: {
                            ...manifestStage.shaderBytecode,
                            bytes: Array.from(dxbc)
                        }
                    } ]
                };
            }
        }
    };
    const compact = buildEffectAnalysis(compactManifestOnly, {
        decodeBytecode: false,
        decodeInstructions: false
    });
    assert.equal(compact.stages[0].shaderBytecode.bytes, undefined);
    assert.equal(compact.stages[0].dxbc, null);
    assert.equal(compact.stages[0].ir, null);

    const invalidManifestBytes = {
        ...resolved,
        stageBytecodeByKey: null,
        bindingManifest: {
            toJSON()
            {
                return {
                    effectName: "fixture",
                    version: 8,
                    passes: [],
                    stages: [ {
                        ...manifestStage,
                        shaderBytecode: {
                            ...manifestStage.shaderBytecode,
                            bytes: [ 0, 256 ]
                        }
                    } ]
                };
            }
        }
    };
    assert.throws(
        () => buildEffectAnalysis(invalidManifestBytes),
        /must contain only byte values/
    );
});
