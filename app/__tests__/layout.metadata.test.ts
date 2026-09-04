// KAN-10 — the root layout's `metadata` export is the only thing Next.js turns into the tab title
// and the Open Graph / Twitter tags a link unfurler reads, so these pin that export's contents.
//
// The export is read out of the source with the TypeScript compiler rather than imported: importing
// app/layout.tsx pulls in `next/font/google` and `./globals.css`, neither of which resolves outside
// the Next.js build. The repo has no unit-test runner, so this runs on node's own:
//   node --test --experimental-strip-types app/__tests__/layout.metadata.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LAYOUT = path.join(REPO, "app", "layout.tsx");

const TITLE = "Asset Panda — Internal Tools";
const DESCRIPTION = "Internal tooling for asset lookup and check-out.";

type MetaValue = string | MetaValue[] | { [key: string]: MetaValue };

/** The literal value of a metadata property: strings, arrays and nested objects, nothing else. */
function toPlainValue(node: ts.Expression): MetaValue {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(toPlainValue);
  if (ts.isObjectLiteralExpression(node)) {
    const entries = node.properties.map((property): [string, MetaValue] => {
      assert.ok(
        ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)),
        `metadata holds a property this test cannot read: ${property.getText()}`,
      );
      return [property.name.text, toPlainValue(property.initializer)];
    });
    return Object.fromEntries(entries);
  }
  return assert.fail(`metadata holds a value this test cannot read: ${node.getText()}`);
}

/** `export const metadata` from app/layout.tsx, as plain data. */
function readMetadata(): Record<string, MetaValue> {
  const source = ts.createSourceFile(
    LAYOUT,
    fs.readFileSync(LAYOUT, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const declaration = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === "metadata");
  assert.ok(declaration?.initializer, "app/layout.tsx must export a metadata object");
  return asObject(toPlainValue(declaration.initializer), "metadata");
}

function asObject(value: MetaValue | undefined, label: string): Record<string, MetaValue> {
  assert.ok(
    value !== undefined && typeof value === "object" && !Array.isArray(value),
    `metadata.${label} must be an object`,
  );
  return value;
}

test("the document title and meta description are the real site's, not create-next-app's", () => {
  const metadata = readMetadata();
  assert.equal(metadata.title, TITLE);
  assert.equal(metadata.description, DESCRIPTION);
});

test("openGraph carries the site title, description, type website and an image in this repo", () => {
  const openGraph = asObject(readMetadata().openGraph, "openGraph");
  assert.equal(openGraph.title, TITLE);
  assert.equal(openGraph.description, DESCRIPTION);
  assert.equal(openGraph.type, "website");

  const [image] = [openGraph.images].flat();
  assert.equal(typeof image, "string", "metadata.openGraph.images must name an image path");
  assert.ok(
    fs.existsSync(path.join(REPO, "public", String(image))),
    `metadata.openGraph.images points at ${String(image)}, which is not a file under public/`,
  );
});

test("twitter asks for the large summary card", () => {
  const twitter = asObject(readMetadata().twitter, "twitter");
  assert.equal(twitter.card, "summary_large_image");
});
