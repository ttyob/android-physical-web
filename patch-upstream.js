"use strict";

const fs = require("node:fs");

const filename = process.argv[2];
if (!filename) {
    throw new Error("usage: node patch-upstream.js <dist/index.js>");
}

const source = fs.readFileSync(filename, "utf8");
const original = "r=t>0&&t<28;";
const replacement = "r=t>0&&t<30;";
const occurrences = source.split(original).length - 1;

if (occurrences === 0 && source.split(replacement).length - 1 === 1) {
    console.log("Android tunnel compatibility patch is already applied");
} else if (occurrences !== 1) {
    throw new Error(`expected one Android tunnel threshold, found ${occurrences}`);
} else {
    fs.writeFileSync(filename, source.replace(original, replacement));
}
