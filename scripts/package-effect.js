import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { readEffectAnalysis } from "../src/core/effectAnalysis.js";
import CjsFormatDxbc from "../../format-dxbc/src/index.js";
import CjsFormatWebgpu from "../src/index.js";

const [ inputArgument, outputArgument ] = process.argv.slice(2);
if (!inputArgument || !outputArgument)
{
    throw new Error("Usage: node scripts/package-effect.js <input.sm_*> <output.cewgpu>");
}

const inputPath = resolve(inputArgument);
const outputPath = resolve(outputArgument);
const input = await readFile(inputPath);
const analysis = CjsFormatWebgpu.analyzeEffect(input, {
    source: inputPath,
    decodeInstructions: true
});
const resolved = readEffectAnalysis(input, { source: inputPath });
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
const entries = analysis.stages.map((stage) =>
{
    const bytecode = bytecodeByKey.get(stage.key);
    if (!bytecode?.length) throw new Error(`${stage.key} has no shader bytecode`);
    return {
        key: stage.key,
        shader: CjsFormatWebgpu.buildWgsl(CjsFormatDxbc.read(bytecode, {
            emit: CjsFormatDxbc.OUTPUT_RAW,
            source: `${inputPath}#${stage.key}`,
            decodeInstructions: true
        }), { source: `${inputPath}#${stage.key}` })
    };
});
const wgsl = CjsFormatWebgpu.buildWgslSet(entries);
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
        selectedOptions: analysis.selectedOptions
    } ],
    [ "ANLS", analysis ],
    [ "WGSL", wgsl ]
]);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, bytes);
console.log(`Wrote ${outputPath} (${bytes.length} bytes, ${wgsl.shaders.length} shaders, ${wgsl.layouts.length} layouts)`);
