import { test } from "node:test";
import assert from "node:assert/strict";

import { computeEntryPointParameters } from "../src/core/wgsl/emitWgsl.js";

const GLOBAL_INVOCATION_ID = Object.freeze({
    builtin: "global_invocation_id",
    name: "dispatch_thread_id",
    type: "vec3<u32>"
});
const SORT_STEP_IDS = Object.freeze([
    Object.freeze({
        builtin: "workgroup_id",
        name: "workgroup_id",
        type: "vec3<u32>"
    }),
    Object.freeze({
        builtin: "local_invocation_id",
        name: "local_invocation_id",
        type: "vec3<u32>"
    })
]);

test("compute entry-point parameters preserve the no-builtin spelling", () =>
{
    assert.equal(computeEntryPointParameters({ stage: "compute" }), "");
});

test("compute entry-point parameters emit the bounded global invocation id", () =>
{
    assert.equal(
        computeEntryPointParameters({
            stage: "compute",
            builtinInputs: [ GLOBAL_INVOCATION_ID ]
        }),
        "@builtin(global_invocation_id) dispatch_thread_id: vec3<u32>"
    );
});

test("compute entry-point parameters emit the ordered sort-step builtin pair", () =>
{
    assert.equal(
        computeEntryPointParameters({
            stage: "compute",
            builtinInputs: SORT_STEP_IDS
        }),
        "@builtin(workgroup_id) workgroup_id: vec3<u32>, "
            + "@builtin(local_invocation_id) local_invocation_id: vec3<u32>"
    );
    assert.throws(() => computeEntryPointParameters({
        builtinInputs: [ ...SORT_STEP_IDS ].reverse()
    }), /unsupported ordered schema/u);
});

test("compute entry-point parameters reject duplicate, unknown, and malformed metadata", () =>
{
    assert.throws(
        () => computeEntryPointParameters({ builtinInputs: [] }),
        /must be a non-empty array/u
    );
    assert.throws(
        () => computeEntryPointParameters({
            builtinInputs: [ GLOBAL_INVOCATION_ID, GLOBAL_INVOCATION_ID ]
        }),
        /duplicates global_invocation_id/u
    );
    assert.throws(
        () => computeEntryPointParameters({
            builtinInputs: [ { ...GLOBAL_INVOCATION_ID, builtin: "local_invocation_id" } ]
        }),
        /unsupported ordered schema/u
    );
    assert.throws(
        () => computeEntryPointParameters({
            builtinInputs: [ { ...GLOBAL_INVOCATION_ID, type: "vec4<u32>" } ]
        }),
        /unsupported ordered schema/u
    );
    assert.throws(
        () => computeEntryPointParameters({
            builtinInputs: [ { ...GLOBAL_INVOCATION_ID, extra: true } ]
        }),
        /contains unsupported metadata/u
    );
});
