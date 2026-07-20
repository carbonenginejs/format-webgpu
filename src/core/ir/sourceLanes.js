const DOT_LANES = Object.freeze({
    dp2: Object.freeze([ "x", "y" ]),
    dp3: Object.freeze([ "x", "y", "z" ]),
    dp4: Object.freeze([ "x", "y", "z", "w" ])
});

const XY = Object.freeze([ "x", "y" ]);
const XYZ = Object.freeze([ "x", "y", "z" ]);

function sampleCoordinateLanes(instruction, program)
{
    const resource = instruction.operands?.[2];
    if (!program || !resource) return XY;
    const reference = resource.resourceReference;
    const binding = (program.bindings || []).find((entry) => entry.resourceKind === "sampled-resource"
        && (reference?.rangeId !== null && reference?.rangeId !== undefined
            ? entry.range?.rangeId === reference.rangeId
            : entry.registerIndex === resource.registerIndex));
    return [ "texturecube", "texture3d", "texture2darray" ].includes(binding?.resourceDimension)
        ? XYZ
        : XY;
}

/**
 * Returns intrinsic source-lane positions for instructions whose inputs are
 * independent of the destination write mask.
 *
 * @param {object} instruction Decoded/IR instruction.
 * @param {number} operandIndex Operand index within the instruction.
 * @param {object} [program] Shader IR, used to resolve sampled-resource dimension.
 * @returns {Array<string>|null} Fixed x/y/z/w positions, when applicable.
 */
export function fixedSourceLanes(instruction, operandIndex, program = null)
{
    const dot = DOT_LANES[instruction.opcodeName];
    if (dot && operandIndex > 0) return dot;
    if (instruction.opcodeName === "ld_structured" && operandIndex === 1) return [ "x" ];
    if ([ "sample", "sample_b", "sample_c", "sample_c_lz", "sample_d", "sample_l", "gather4" ]
        .includes(instruction.opcodeName))
    {
        if (operandIndex === 1) return sampleCoordinateLanes(instruction, program);
        if (instruction.opcodeName === "sample_d" && [ 4, 5 ].includes(operandIndex)) return XY;
        if ([ "sample_b", "sample_c", "sample_l" ].includes(instruction.opcodeName) && operandIndex === 4) return [ "x" ];
    }
    return null;
}
