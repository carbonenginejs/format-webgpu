const SCALAR_TYPE_NAMES = Object.freeze({
    float32: "f32", int32: "i32", uint32: "u32", bool: "bool", bitpattern32: "u32"
});

function scalarTypeName(type)
{
    return SCALAR_TYPE_NAMES[type] || null;
}

/** Returns the WGSL zero literal for a scalar IR type, or null. */
export function zeroForType(type)
{
    return ({ float32: "0.0", int32: "0i", uint32: "0u", bitpattern32: "0u", bool: "false" })[type] || null;
}

/** Clones the per-field output-component write tracking map. */
export function cloneWritten(written)
{
    return new Map(Array.from(written, ([ key, value ]) => [ key, new Set(value) ]));
}

/** Finds the basic block containing an instruction index. */
export function blockForInstruction(program, instructionIndex)
{
    return program.blocks.find((block) => instructionIndex >= block.startInstruction && instructionIndex <= block.endInstruction) || null;
}

function buildDominators(program)
{
    const reachable = program.blocks.filter((block) => block.reachable !== false);
    const all = new Set(reachable.map((block) => block.id));
    const entry = reachable[0];
    const dominators = new Map(reachable.map((block) => [ block.id, block === entry ? new Set([ block.id ]) : new Set(all) ]));
    let changed = true;
    while (changed)
    {
        changed = false;
        for (const block of reachable.slice(1))
        {
            const predecessors = block.predecessors
                .map((edge) => dominators.get(edge.blockId))
                .filter(Boolean);
            const next = predecessors.length ? new Set(predecessors[0]) : new Set();
            for (const candidate of Array.from(next))
            {
                if (predecessors.some((set) => !set.has(candidate))) next.delete(candidate);
            }
            next.add(block.id);
            const current = dominators.get(block.id);
            if (next.size !== current.size || Array.from(next).some((id) => !current.has(id)))
            {
                dominators.set(block.id, next);
                changed = true;
            }
        }
    }
    return dominators;
}

function loopHeaderMergeIds(program)
{
    const ids = new Set();
    for (const region of program.controlFlow.regions)
    {
        if (region.kind !== "loop") continue;
        const header = blockForInstruction(program, region.startInstruction);
        for (const id of header?.mergeSite?.valueIds || []) ids.add(id);
    }
    return ids;
}

function liveMergeIds(program, values, stage, loopMergeIds)
{
    const live = new Set();
    const visiting = new Set();
    function visit(id)
    {
        const value = values.get(id);
        if (value?.origin !== "control-flow-merge" || live.has(id)) return;
        if (visiting.has(id))
        {
            if (loopMergeIds.has(id)) return;
            throw new Error(`WGSL ${stage} merge graph contains a cycle at ${id}`);
        }
        visiting.add(id);
        for (const incoming of value.incoming) visit(incoming.valueId);
        visiting.delete(id);
        live.add(id);
    }
    for (const instruction of program.instructions)
    {
        for (const ref of instruction.dataflow.reads.flatMap((read) => read.refs)) visit(ref.valueId);
    }
    return live;
}

function definitionDominates(value, targetBlockId, targetInstruction, dominators)
{
    if (value?.origin === "program-input") return true;
    if (!value?.blockId || !dominators.get(targetBlockId)?.has(value.blockId)) return false;
    return value.blockId !== targetBlockId
        || value.origin !== "instruction-write"
        || value.instructionIndex < targetInstruction;
}

function extendUndefinedPaths(paths, conditionId, nonzero)
{
    const extended = [];
    for (const path of paths)
    {
        const existing = path.get(conditionId);
        if (existing !== undefined && existing !== nonzero) continue;
        const next = new Map(path);
        next.set(conditionId, nonzero);
        extended.push(next);
    }
    return extended;
}

function validateUndefinedMergePaths(program, live, values, plans, stage)
{
    const mergePlans = new Map();
    for (const plan of plans.values())
    {
        for (const merge of plan.merges) mergePlans.set(merge.id, { plan, merge });
    }
    const memo = new Map();
    const visiting = new Set();

    function undefinedPaths(valueId)
    {
        const value = values.get(valueId);
        if (value?.origin === "undefined-register") return [ new Map() ];
        if (value?.origin !== "control-flow-merge" || !live.has(valueId)) return [];
        if (memo.has(valueId)) return memo.get(valueId);
        if (visiting.has(valueId)) throw new Error(`WGSL ${stage} merge graph contains a cycle at ${valueId}`);
        const entry = mergePlans.get(valueId);
        if (!entry) throw new Error(`WGSL ${stage} merge ${valueId} has no selection plan`);
        if (entry.plan.kind === "switch" || entry.plan.kind === "loop" || entry.merge.viaSwitch) return [];
        visiting.add(valueId);
        const { plan, merge } = entry;
        const trueRequiresNonzero = plan.testBoolean !== "zero";
        const paths = [
            ...extendUndefinedPaths(undefinedPaths(merge.falseIncoming.valueId), plan.conditionId, !trueRequiresNonzero),
            ...extendUndefinedPaths(undefinedPaths(merge.trueIncoming.valueId), plan.conditionId, trueRequiresNonzero)
        ];
        visiting.delete(valueId);
        memo.set(valueId, paths);
        return paths;
    }

    for (const id of live)
    {
        const directlyRead = program.instructions.some((instruction) => instruction.dataflow.reads
            .some((read) => read.refs.some((ref) => ref.valueId === id)));
        if (directlyRead && undefinedPaths(id).length)
        {
            throw new Error(`WGSL ${stage} merge ${id} has an observable undefined path`);
        }
    }
}

function buildSwitchPlan(program, region, values, live, dominators, stage, sharedJoin = false)
{
    const header = blockForInstruction(program, region.startInstruction);
    const join = blockForInstruction(program, region.endInstruction + 1);
    if (!header || !join || header.endInstruction !== region.startInstruction || join.startInstruction !== region.endInstruction + 1)
    {
        throw new Error(`WGSL ${stage} switch at ${region.startInstruction} has malformed block boundaries`);
    }
    const markers = [ ...region.caseInstructions, ...(region.defaultInstruction !== null ? [ region.defaultInstruction ] : []) ]
        .sort((left, right) => left - right);
    if (!markers.length || markers[0] !== region.startInstruction + 1)
    {
        throw new Error(`WGSL ${stage} switch at ${region.startInstruction} has unsupported leading instructions`);
    }
    const clauses = [];
    for (let index = 0; index < markers.length;)
    {
        const group = [ markers[index] ];
        while (index + 1 < markers.length && markers[index + 1] === markers[index] + 1)
        {
            index += 1;
            group.push(markers[index]);
        }
        index += 1;
        const bodyEndMarker = index < markers.length ? markers[index] : region.endInstruction;
        clauses.push({ markerInstructions: group, bodyStart: group.at(-1) + 1, bodyEndMarker });
    }
    const seenSelectors = new Set();
    for (const clause of clauses)
    {
        const last = program.instructions[clause.bodyEndMarker - 1];
        if (last?.opcodeName === "break")
        {
            clause.terminator = "break";
            clause.bodyEnd = clause.bodyEndMarker - 1;
            clause.tailBlockId = blockForInstruction(program, last.index)?.id ?? null;
        }
        else if (last?.opcodeName === "ret")
        {
            clause.terminator = "ret";
            clause.bodyEnd = clause.bodyEndMarker;
            clause.tailBlockId = null;
        }
        else
        {
            throw new Error(`WGSL ${stage} switch case at ${clause.markerInstructions[0]} must end in break or return`);
        }
        clause.isDefault = clause.markerInstructions.includes(region.defaultInstruction);
        clause.selectors = clause.markerInstructions
            .filter((marker) => marker !== region.defaultInstruction)
            .map((marker) =>
            {
                const operand = program.instructions[marker].operands?.[0];
                const bits = operand?.immediateValues?.[0]?.uint32;
                if (operand?.typeName !== "immediate32" || !Number.isInteger(bits))
                {
                    throw new Error(`WGSL ${stage} switch case at ${marker} requires an immediate selector`);
                }
                const selector = bits >>> 0;
                if (seenSelectors.has(selector))
                {
                    throw new Error(`WGSL ${stage} switch at ${region.startInstruction} has duplicate selector ${selector}`);
                }
                seenSelectors.add(selector);
                return selector;
            });
    }
    const mergeIds = sharedJoin ? [] : (join.mergeSite?.valueIds || []).filter((id) => live.has(id));
    let merges = [];
    if (mergeIds.length)
    {
        if (region.defaultInstruction === null)
        {
            throw new Error(`WGSL ${stage} switch at ${region.startInstruction} carries merges without a default case`);
        }
        const reachableJoinPredecessors = join.predecessors.filter((edge) =>
            program.blocks.find((block) => block.id === edge.blockId)?.reachable !== false);
        if (clauses.some((clause) => clause.terminator !== "break") || reachableJoinPredecessors.length !== clauses.length)
        {
            throw new Error(`WGSL ${stage} switch at ${region.startInstruction} has unsupported merge predecessors`);
        }
        const tailBlockIds = new Set(clauses.map((clause) => clause.tailBlockId));
        merges = mergeIds.map((id) =>
        {
            const value = values.get(id);
            const type = value?.componentTypes?.[value.writeMask];
            const wgslType = scalarTypeName(type);
            if (!value || value.origin !== "control-flow-merge" || value.incoming.length > clauses.length
                || value.writeMask.length !== 1 || !wgslType || !zeroForType(type)
                || value.incoming.some((incoming) => incoming.kind !== "predecessor"))
            {
                throw new Error(`WGSL ${stage} merge ${id} is not a scalar switch phi`);
            }
            const passThrough = value.incoming.filter((incoming) => !tailBlockIds.has(incoming.blockId));
            if (passThrough.length > 1)
            {
                throw new Error(`WGSL ${stage} merge ${id} has unsupported switch incoming edges`);
            }
            const fallback = passThrough[0] || null;
            if (fallback)
            {
                const fallbackValue = values.get(fallback.valueId);
                if (mergeIds.includes(fallback.valueId) || fallbackValue?.origin === "undefined-register"
                    || !definitionDominates(fallbackValue, header.id, region.startInstruction, dominators))
                {
                    throw new Error(`WGSL ${stage} merge ${id} pass-through input does not dominate the switch`);
                }
            }
            const incomingByBlock = new Map(value.incoming.map((incoming) => [ incoming.blockId, incoming ]));
            const perClause = clauses.map((clause) =>
            {
                const incoming = incomingByBlock.get(clause.tailBlockId) || fallback;
                if (!incoming || mergeIds.includes(incoming.valueId))
                {
                    throw new Error(`WGSL ${stage} merge ${id} has unsupported switch incoming edges`);
                }
                if (incoming === fallback) return incoming;
                const incomingValue = values.get(incoming.valueId);
                const tailBlock = program.blocks.find((block) => block.id === clause.tailBlockId);
                if (incomingValue?.origin === "undefined-register"
                    || !definitionDominates(incomingValue, clause.tailBlockId, tailBlock.endInstruction + 1, dominators))
                {
                    throw new Error(`WGSL ${stage} merge ${id} case input does not dominate its edge`);
                }
                return incoming;
            });
            return { id, type: wgslType, zeroCode: zeroForType(type), perClause };
        });
    }
    return { kind: "switch", region, header, join, clauses, merges, sharedJoin, outerMerges: [] };
}

function buildLoopPlan(program, region, values, live, dominators, stage)
{
    const header = blockForInstruction(program, region.startInstruction);
    if (!header || header.startInstruction !== region.startInstruction)
    {
        throw new Error(`WGSL ${stage} loop at ${region.startInstruction} has malformed block boundaries`);
    }
    const backedgeBlock = blockForInstruction(program, region.endInstruction);
    const preheaderPredecessors = header.predecessors.filter((edge) => edge.blockId !== backedgeBlock?.id);
    if (!backedgeBlock || preheaderPredecessors.length !== 1)
    {
        throw new Error(`WGSL ${stage} loop at ${region.startInstruction} has unsupported header predecessors`);
    }
    const preheaderBlockId = preheaderPredecessors[0].blockId;
    for (let index = region.startInstruction + 1; index < region.endInstruction; index += 1)
    {
        const opcode = program.instructions[index].opcodeName;
        if (opcode === "continue" || opcode === "continuec")
        {
            throw new Error(`WGSL ${stage} loop at ${region.startInstruction} does not support ${opcode}`);
        }
    }
    const mergeIds = (header.mergeSite?.valueIds || []).filter((id) => live.has(id));
    const merges = mergeIds.map((id) =>
    {
        const value = values.get(id);
        const type = value?.componentTypes?.[value.writeMask];
        const wgslType = scalarTypeName(type);
        if (!value || value.origin !== "control-flow-merge" || value.incoming.length !== 2
            || value.writeMask.length !== 1 || !wgslType || !zeroForType(type)
            || value.incoming.some((incoming) => incoming.kind !== "predecessor"))
        {
            throw new Error(`WGSL ${stage} merge ${id} is not a scalar loop phi`);
        }
        const entryIncoming = value.incoming.find((incoming) => incoming.blockId === preheaderBlockId);
        const backedgeIncoming = value.incoming.find((incoming) => incoming.blockId === backedgeBlock.id);
        if (!entryIncoming || !backedgeIncoming)
        {
            throw new Error(`WGSL ${stage} merge ${id} has unsupported loop incoming edges`);
        }
        const entryValue = values.get(entryIncoming.valueId);
        const backedgeValue = values.get(backedgeIncoming.valueId);
        if (entryValue?.origin === "undefined-register"
            || !definitionDominates(entryValue, preheaderBlockId,
                program.blocks.find((block) => block.id === preheaderBlockId).endInstruction + 1, dominators))
        {
            throw new Error(`WGSL ${stage} merge ${id} entry input does not dominate the loop`);
        }
        if (backedgeValue?.origin === "undefined-register"
            || (backedgeValue?.id !== id
                && !definitionDominates(backedgeValue, backedgeBlock.id, region.endInstruction + 1, dominators)))
        {
            throw new Error(`WGSL ${stage} merge ${id} backedge input does not dominate the loop latch`);
        }
        return { id, type: wgslType, zeroCode: zeroForType(type), entryIncoming, backedgeIncoming };
    });
    return { kind: "loop", region, header, preheaderBlockId, backedgeBlockId: backedgeBlock.id, merges };
}

/**
 * Plans every structured selection and switch region for WGSL emission. Each
 * selection plan records the header/join blocks, arm tail identities,
 * condition projection, and the scalar float merge values that must become
 * mutable variables; two-armed regions identify their arm tails through
 * selection-merge/fallthrough join edges, while no-else regions treat the
 * header fall-through as the false edge. Switch plans record grouped
 * break-terminated case clauses, immediate selectors, and per-clause merge
 * incoming values at the after-endswitch join.
 *
 * @param {object} program Frozen CJS shader IR.
 * @param {string} stage Stage label for diagnostics ("vertex" or "fragment").
 * @returns {Map<number, object>} Region plans keyed by region start instruction.
 */
export function buildSelectionPlans(program, stage)
{
    const values = new Map(program.values.map((value) => [ value.id, value ]));
    const loopMergeIds = loopHeaderMergeIds(program);
    const live = liveMergeIds(program, values, stage, loopMergeIds);
    const dominators = buildDominators(program);
    const plans = new Map();
    const sharedSwitchBySelection = new Map();
    const sharedSelectionBySwitch = new Map();
    for (const region of program.controlFlow.regions)
    {
        if (region.kind !== "switch") continue;
        const enclosing = program.controlFlow.regions
            .filter((candidate) => candidate.kind === "selection" && candidate.elseInstruction === null
                && candidate.startInstruction < region.startInstruction
                && candidate.endInstruction === region.endInstruction + 1)
            .sort((left, right) => right.startInstruction - left.startInstruction)[0];
        if (enclosing)
        {
            sharedSwitchBySelection.set(enclosing.startInstruction, region);
            sharedSelectionBySwitch.set(region.startInstruction, enclosing);
        }
    }
    for (const region of program.controlFlow.regions)
    {
        if (region.kind === "switch")
        {
            if (plans.has(region.startInstruction)) continue;
            plans.set(region.startInstruction, buildSwitchPlan(
                program, region, values, live, dominators, stage, sharedSelectionBySwitch.has(region.startInstruction)));
            continue;
        }
        if (region.kind === "loop")
        {
            plans.set(region.startInstruction, buildLoopPlan(program, region, values, live, dominators, stage));
            continue;
        }
        if (region.kind !== "selection")
        {
            throw new Error(`WGSL ${stage} body slice supports only selection, switch, and loop control flow`);
        }
        const hasElse = region.elseInstruction !== null;
        const header = blockForInstruction(program, region.startInstruction);
        const join = blockForInstruction(program, region.endInstruction);
        if (!header || !join || header.endInstruction !== region.startInstruction || join.startInstruction !== region.endInstruction)
        {
            throw new Error(`WGSL ${stage} selection at ${region.startInstruction} has malformed block boundaries`);
        }
        const mergeIds = (join.mergeSite?.valueIds || []).filter((id) => live.has(id));
        const sharedSwitch = !hasElse ? sharedSwitchBySelection.get(region.startInstruction) : undefined;
        if (sharedSwitch)
        {
            const switchPlan = buildSwitchPlan(program, sharedSwitch, values, live, dominators, stage, true);
            plans.set(sharedSwitch.startInstruction, switchPlan);
            const sharedIf = program.instructions[region.startInstruction];
            const sharedConditionRefs = sharedIf.dataflow.reads.flatMap((read) => read.refs);
            const sharedConditionId = sharedConditionRefs.length === 1
                ? sharedConditionRefs[0].valueId
                : `selection:${region.startInstruction}`;
            if (![ "zero", "nonzero" ].includes(sharedIf.testBoolean))
            {
                throw new Error(`WGSL ${stage} if instruction ${sharedIf.index} has no supported condition projection`);
            }
            let sharedMerges = [];
            if (mergeIds.length)
            {
                const reachablePredecessors = join.predecessors.filter((edge) =>
                    program.blocks.find((block) => block.id === edge.blockId)?.reachable !== false);
                if (sharedSwitch.defaultInstruction === null
                    || switchPlan.clauses.some((clause) => clause.terminator !== "break")
                    || reachablePredecessors.length !== switchPlan.clauses.length + 1)
                {
                    throw new Error(`WGSL ${stage} selection at ${region.startInstruction} has unsupported merge predecessors`);
                }
                sharedMerges = mergeIds.map((id) =>
                {
                    const value = values.get(id);
                    const type = value?.componentTypes?.[value.writeMask];
                    const wgslType = scalarTypeName(type);
                    if (!value || value.origin !== "control-flow-merge"
                        || value.incoming.length !== switchPlan.clauses.length + 1
                        || value.writeMask.length !== 1 || !wgslType || !zeroForType(type)
                        || value.incoming.some((incoming) => incoming.kind !== "predecessor"))
                    {
                        throw new Error(`WGSL ${stage} merge ${id} is not a scalar shared-join phi`);
                    }
                    const falseIncoming = value.incoming.find((incoming) => incoming.blockId === header.id);
                    if (!falseIncoming || mergeIds.includes(falseIncoming.valueId))
                    {
                        throw new Error(`WGSL ${stage} merge ${id} has unsupported incoming edges`);
                    }
                    const falseValue = values.get(falseIncoming.valueId);
                    if (falseValue?.origin === "undefined-register"
                        || !definitionDominates(falseValue, header.id, region.startInstruction, dominators))
                    {
                        throw new Error(`WGSL ${stage} merge ${id} false input does not dominate its declaration`);
                    }
                    const incomingByBlock = new Map(value.incoming.map((incoming) => [ incoming.blockId, incoming ]));
                    const perClause = switchPlan.clauses.map((clause) =>
                    {
                        const incoming = incomingByBlock.get(clause.tailBlockId);
                        if (!incoming || mergeIds.includes(incoming.valueId))
                        {
                            throw new Error(`WGSL ${stage} merge ${id} has unsupported switch incoming edges`);
                        }
                        const incomingValue = values.get(incoming.valueId);
                        const tailBlock = program.blocks.find((block) => block.id === clause.tailBlockId);
                        if (incomingValue?.origin === "undefined-register"
                            || !definitionDominates(incomingValue, clause.tailBlockId, tailBlock.endInstruction + 1, dominators))
                        {
                            throw new Error(`WGSL ${stage} merge ${id} case input does not dominate its edge`);
                        }
                        return incoming;
                    });
                    return {
                        id,
                        type: wgslType,
                        zeroCode: zeroForType(type),
                        falseIncoming,
                        falseCode: undefined,
                        undefinedFallback: false,
                        viaSwitch: true,
                        perClause
                    };
                });
                switchPlan.outerMerges = sharedMerges;
            }
            plans.set(region.startInstruction, {
                kind: "selection",
                region,
                hasElse: false,
                header,
                join,
                trueBlockId: null,
                falseBlockId: header.id,
                conditionId: sharedConditionId,
                testBoolean: sharedIf.testBoolean,
                merges: sharedMerges
            });
            continue;
        }
        let trueBlockId = null;
        let falseBlockId = null;
        if (hasElse)
        {
            trueBlockId = join.predecessors.find((edge) => edge.kind === "selection-merge")?.blockId ?? null;
            falseBlockId = join.predecessors.find((edge) => edge.kind === "fallthrough")?.blockId ?? null;
            if (mergeIds.length && (join.predecessors.length !== 2 || !trueBlockId || !falseBlockId))
            {
                throw new Error(`WGSL ${stage} selection at ${region.startInstruction} has unsupported merge predecessors`);
            }
        }
        else
        {
            falseBlockId = header.id;
            const truePredecessors = join.predecessors.filter((edge) => edge.blockId !== header.id);
            if (mergeIds.length && (join.predecessors.length !== 2 || truePredecessors.length !== 1))
            {
                throw new Error(`WGSL ${stage} selection at ${region.startInstruction} has unsupported merge predecessors`);
            }
            trueBlockId = truePredecessors[0]?.blockId || null;
        }
        const ifInstruction = program.instructions[region.startInstruction];
        const conditionRefs = ifInstruction.dataflow.reads.flatMap((read) => read.refs);
        const conditionId = conditionRefs.length === 1
            ? conditionRefs[0].valueId
            : `selection:${region.startInstruction}`;
        if (![ "zero", "nonzero" ].includes(ifInstruction.testBoolean))
        {
            throw new Error(`WGSL ${stage} if instruction ${ifInstruction.index} has no supported condition projection`);
        }
        const testBoolean = ifInstruction.testBoolean;
        const merges = mergeIds.map((id) =>
        {
            const value = values.get(id);
            const type = value?.componentTypes?.[value.writeMask];
            const wgslType = scalarTypeName(type);
            if (!value || value.origin !== "control-flow-merge" || value.incoming.length !== 2
                || value.writeMask.length !== 1 || !wgslType || !zeroForType(type)
                || value.incoming.some((incoming) => incoming.kind !== "predecessor"))
            {
                throw new Error(`WGSL ${stage} merge ${id} is not a scalar float predecessor phi`);
            }
            const falseIncoming = value.incoming.find((incoming) => incoming.blockId === falseBlockId);
            const trueIncoming = value.incoming.find((incoming) => incoming.blockId === trueBlockId);
            if (!falseIncoming || !trueIncoming || [ falseIncoming, trueIncoming ].some((incoming) => mergeIds.includes(incoming.valueId)))
            {
                throw new Error(`WGSL ${stage} merge ${id} has unsupported incoming edges`);
            }
            const falseValue = values.get(falseIncoming.valueId);
            const trueValue = values.get(trueIncoming.valueId);
            let falseCode;
            let undefinedFallback = false;
            if (falseValue?.origin === "undefined-register")
            {
                falseCode = zeroForType(type);
                undefinedFallback = true;
                if (!falseCode)
                {
                    throw new Error(`WGSL ${stage} merge ${id} has an observable undefined false input`);
                }
            }
            else if (hasElse
                ? !definitionDominates(falseValue, falseBlockId, program.blocks.find((block) => block.id === falseBlockId).endInstruction + 1, dominators)
                : !definitionDominates(falseValue, header.id, region.startInstruction, dominators))
            {
                throw new Error(`WGSL ${stage} merge ${id} false input does not dominate its declaration`);
            }
            if (trueValue?.origin === "undefined-register"
                || !definitionDominates(trueValue, trueBlockId, program.blocks.find((block) => block.id === trueBlockId).endInstruction + 1, dominators))
            {
                throw new Error(`WGSL ${stage} merge ${id} true input does not dominate its edge`);
            }
            return { id, type: wgslType, zeroCode: zeroForType(type), falseIncoming, trueIncoming, falseCode, undefinedFallback };
        });
        plans.set(region.startInstruction, {
            kind: "selection",
            region,
            hasElse,
            header,
            join,
            trueBlockId,
            falseBlockId,
            conditionId,
            testBoolean,
            merges
        });
    }

    validateUndefinedMergePaths(program, live, values, plans, stage);

    for (const id of live)
    {
        const value = values.get(id);
        for (const instruction of program.instructions)
        {
            if (!instruction.dataflow.reads.some((read) => read.refs.some((ref) => ref.valueId === id))) continue;
            const useBlock = blockForInstruction(program, instruction.index);
            if (!dominators.get(useBlock.id)?.has(value.blockId))
            {
                throw new Error(`WGSL ${stage} merge ${id} does not dominate instruction ${instruction.index}`);
            }
        }
        for (const downstreamId of live)
        {
            const downstream = values.get(downstreamId);
            for (const incoming of downstream.incoming.filter((entry) => entry.valueId === id))
            {
                if (!dominators.get(incoming.blockId)?.has(value.blockId))
                {
                    throw new Error(`WGSL ${stage} merge ${id} does not dominate downstream edge ${incoming.blockId}`);
                }
            }
        }
    }
    return plans;
}
