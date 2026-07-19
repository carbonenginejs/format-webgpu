import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { readEffectAnalysis } from "../src/core/effectAnalysis.js";
import CjsFormatDxbc from "@carbonenginejs/format-dxbc";
import CjsFormatWebgpu from "../src/index.js";
import {
    buildWgslSelectionMetadata,
    parsePackageEffectArguments,
    selectPackageEffectStages,
    validateMatchingEffectResolution,
    validatePackageEffectPaths,
    validateResolvedPermutation
} from "./packageEffectSelection.js";

const { inputArgument, outputArgument, permutation, selection } = parsePackageEffectArguments(process.argv.slice(2));

const inputPath = resolve(inputArgument);
const outputPath = resolve(outputArgument);
validatePackageEffectPaths(inputPath, outputPath);
const input = await readFile(inputPath);
const analysis = CjsFormatWebgpu.analyzeEffect(input, {
    source: inputPath,
    decodeInstructions: true,
    permutation
});
validateResolvedPermutation(permutation, analysis.selectedOptions);
const resolved = readEffectAnalysis(input, { source: inputPath, permutation });
validateMatchingEffectResolution(analysis, resolved.selection);
const bytecodeByKey = new Map();
for (const technique of resolved.effectDescription?.techniques || [])
{
    for (let passIndex = 0; passIndex < technique.passes.length; passIndex += 1)
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
const selectedStages = selectPackageEffectStages(analysis.stages, selection);
const irEntries = selectedStages.map((stage) =>
{
    const bytecode = bytecodeByKey.get(stage.key);
    if (!bytecode?.length) throw new Error(`${stage.key} has no shader bytecode`);
    const ir = CjsFormatWebgpu.buildShaderIr(CjsFormatDxbc.read(bytecode, {
        emit: CjsFormatDxbc.OUTPUT_RAW,
        source: `${inputPath}#${stage.key}`,
        decodeInstructions: true
    }), { source: `${inputPath}#${stage.key}` });
    return {
        key: stage.key,
        passKey: `${stage.techniqueName}.pass${stage.passIndex}`,
        ir
    };
});
const programsByPass = new Map();
for (const entry of irEntries)
{
    if (!programsByPass.has(entry.passKey)) programsByPass.set(entry.passKey, []);
    programsByPass.get(entry.passKey).push(entry.ir);
}
const plans = new Map(Array.from(programsByPass, ([ key, programs ]) => [
    key,
    CjsFormatWebgpu.buildWgslBindingPlan(programs)
]));
const entries = irEntries.map((entry) => ({
    key: entry.key,
    shader: CjsFormatWebgpu.buildWgsl(entry.ir, { bindingPlan: plans.get(entry.passKey) })
}));
const wgsl = CjsFormatWebgpu.buildWgslSet(entries);
const wgslSelection = buildWgslSelectionMetadata(selection, selectedStages);
const bytes = CjsFormatWebgpu.build([
    [ "INFO", {
        format: "CEWGPU",
        formatVersion: 1,
        sourcePath: inputPath,
        stageCount: analysis.stages.length,
        shaderCount: wgsl.shaders.length
    } ],
    [ "META", {
        effectName: analysis.effectName,
        sourcePath: inputPath,
        bodyIndex: analysis.bodyIndex,
        selectedOptions: analysis.selectedOptions,
        ...(wgslSelection ? { wgslSelection } : {})
    } ],
    [ "ANLS", analysis ],
    [ "WGSL", wgsl ]
]);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, bytes);
console.log(`Wrote ${outputPath} (${bytes.length} bytes, ${wgsl.shaders.length} shaders, ${wgsl.layouts.length} layouts)`);
