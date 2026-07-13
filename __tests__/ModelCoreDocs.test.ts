import * as fs from "fs";
import * as path from "path";

describe("model-core docs", () => {
  it("references existing npm scripts and python scripts", () => {
    const root = path.resolve(__dirname, "..");
    const docs = fs.readFileSync(path.join(root, "docs", "model-core.md"), "utf8");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const npmScripts = [...docs.matchAll(/npm run ([a-z0-9:-]+)/g)].map(match => match[1]);
    const pythonScripts = [...docs.matchAll(/python (scripts\/model-core\/[^\s]+)/g)].map(match => match[1]);

    expect(npmScripts).toEqual(expect.arrayContaining([
      "battle-dsl",
      "enumerate-candidates",
      "build-action-dataset",
      "generate-script",
      "record-feedback",
      "model-core-retrain",
      "model-core-decision",
      "model-core-smoke-test",
    ]));
    for (const script of npmScripts) expect(pkg.scripts[script]).toBeTruthy();
    for (const script of pythonScripts) expect(fs.existsSync(path.join(root, script))).toBe(true);
  });
});
