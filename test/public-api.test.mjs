import { test } from "node:test";
import assert from "node:assert/strict";

import CjsFormatWebgpu, { CjsFormatWebgpu as NamedCjsFormatWebgpu } from "../src/index.js";

class Package {}
class Resource {}

test("package root exports one public class", async () =>
{
    const mod = await import("../src/index.js");

    assert.deepEqual(Object.keys(mod).sort(), [ "CjsFormatWebgpu", "default" ]);
    assert.equal(mod.default, CjsFormatWebgpu);
    assert.equal(mod.CjsFormatWebgpu, CjsFormatWebgpu);
    assert.equal(NamedCjsFormatWebgpu, CjsFormatWebgpu);
});

test("reader exposes the standard public profile API", () =>
{
    assert.deepEqual(Object.getOwnPropertyNames(CjsFormatWebgpu.prototype).sort(), [
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
    const reader = new CjsFormatWebgpu({ classes: { Package } }).SetClass("Resource", Resource);

    assert.equal(reader.HasClass("Package"), true);
    assert.equal(reader.HasClass("Resource"), true);
    assert.equal(reader.GetClass("Package"), Package);
    assert.equal(reader.GetValues().emit, CjsFormatWebgpu.OUTPUT_JSON);
});

test("read and inspect are explicit placeholders", () =>
{
    assert.throws(() => CjsFormatWebgpu.read(new Uint8Array()), /not implemented yet/);
    assert.throws(() => new CjsFormatWebgpu().Inspect(new Uint8Array()), /not implemented yet/);
});

test("toJSON converts class instances to plain values", () =>
{
    const value = new Package();
    value.name = "package";

    assert.deepEqual(CjsFormatWebgpu.toJSON(value), { name: "package" });
});
