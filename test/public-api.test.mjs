import { test } from "node:test";
import assert from "node:assert/strict";

import CjsWebGPUReader, { CjsWebGPUReader as NamedCjsWebGPUReader } from "../src/index.js";

class Package {}
class Resource {}

test("package root exports one public class", async () =>
{
    const mod = await import("../src/index.js");

    assert.deepEqual(Object.keys(mod).sort(), [ "CjsWebGPUReader", "default" ]);
    assert.equal(mod.default, CjsWebGPUReader);
    assert.equal(mod.CjsWebGPUReader, CjsWebGPUReader);
    assert.equal(NamedCjsWebGPUReader, CjsWebGPUReader);
});

test("reader exposes the standard public profile API", () =>
{
    assert.deepEqual(Object.getOwnPropertyNames(CjsWebGPUReader.prototype).sort(), [
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
    const reader = new CjsWebGPUReader({ classes: { Package } }).SetClass("Resource", Resource);

    assert.equal(reader.HasClass("Package"), true);
    assert.equal(reader.HasClass("Resource"), true);
    assert.equal(reader.GetClass("Package"), Package);
    assert.equal(reader.GetValues().emit, CjsWebGPUReader.OUTPUT_JSON);
});

test("read and inspect are explicit placeholders", () =>
{
    assert.throws(() => CjsWebGPUReader.read(new Uint8Array()), /not implemented yet/);
    assert.throws(() => new CjsWebGPUReader().Inspect(new Uint8Array()), /not implemented yet/);
});

test("toJSON converts class instances to plain values", () =>
{
    const value = new Package();
    value.name = "package";

    assert.deepEqual(CjsWebGPUReader.toJSON(value), { name: "package" });
});
