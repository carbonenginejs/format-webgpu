const DOT_LANES = Object.freeze({
    dp2: Object.freeze([ "x", "y" ]),
    dp3: Object.freeze([ "x", "y", "z" ]),
    dp4: Object.freeze([ "x", "y", "z", "w" ])
});

/**
 * Returns intrinsic source-lane positions for instructions whose inputs are
 * independent of the destination write mask.
 *
 * @param {object} instruction Decoded/IR instruction.
 * @param {number} operandIndex Operand index within the instruction.
 * @returns {Array<string>|null} Fixed x/y/z/w positions, when applicable.
 */
export function fixedSourceLanes(instruction, operandIndex)
{
    const dot = DOT_LANES[instruction.opcodeName];
    if (dot && operandIndex > 0) return dot;
    if (instruction.opcodeName === "ld_structured" && operandIndex === 1) return [ "x" ];
    if ([ "sample", "sample_b", "sample_c", "sample_c_lz", "sample_d", "sample_l", "gather4" ]
        .includes(instruction.opcodeName))
    {
        if (operandIndex === 1) return [ "x", "y" ];
        if (instruction.opcodeName === "sample_d" && [ 4, 5 ].includes(operandIndex)) return [ "x", "y" ];
        if ([ "sample_b", "sample_c", "sample_l" ].includes(instruction.opcodeName) && operandIndex === 4) return [ "x" ];
    }
    return null;
}
