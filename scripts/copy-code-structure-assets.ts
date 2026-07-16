import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createRequire } from "node:module";

const resolver = createRequire(import.meta.url);

export const CODE_STRUCTURE_ASSET_FILES = [
  "tree-sitter.wasm",
  "tree-sitter-python.wasm",
  "tree-sitter-javascript.wasm",
  "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm",
  "tree-sitter-go.wasm",
  "tree-sitter-rust.wasm",
] as const;

export interface CodeStructureAssetManifest {
  webTreeSitterVersion: string;
  grammarPackageVersion: string;
  files: Record<string, string>;
}

interface PackageMetadata {
  version: string;
}

async function readPackageMetadata(packageJsonPath: string): Promise<PackageMetadata> {
  return JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as PackageMetadata;
}

function sourcePath(fileName: string): string {
  if (fileName === "tree-sitter.wasm") {
    return resolver.resolve("web-tree-sitter/tree-sitter.wasm");
  }
  const grammarPackageDir = path.dirname(resolver.resolve("tree-sitter-wasms/package.json"));
  return path.join(grammarPackageDir, "out", fileName);
}

export async function copyCodeStructureAssets(
  targetDirectory: string
): Promise<CodeStructureAssetManifest> {
  await fs.mkdir(targetDirectory, { recursive: true });

  const files: Record<string, string> = {};
  for (const fileName of CODE_STRUCTURE_ASSET_FILES) {
    const contents = await fs.readFile(sourcePath(fileName));
    files[fileName] = createHash("sha256").update(contents).digest("hex");
    await fs.writeFile(path.join(targetDirectory, fileName), contents);
  }

  const webTreeSitterPackagePath = resolver.resolve("web-tree-sitter/package.json");
  const grammarPackagePath = resolver.resolve("tree-sitter-wasms/package.json");
  const [webTreeSitter, grammarPackage] = await Promise.all([
    readPackageMetadata(webTreeSitterPackagePath),
    readPackageMetadata(grammarPackagePath),
  ]);
  const manifest: CodeStructureAssetManifest = {
    webTreeSitterVersion: webTreeSitter.version,
    grammarPackageVersion: grammarPackage.version,
    files,
  };
  await fs.writeFile(
    path.join(targetDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  return manifest;
}

if (import.meta.main) {
  const targets = process.argv.slice(2);
  const outputDirectories =
    targets.length > 0
      ? targets
      : [
          path.join(process.cwd(), "dist/node/services/codeStructure/assets"),
          path.join(process.cwd(), "dist/runtime/assets"),
        ];
  await Promise.all(outputDirectories.map(copyCodeStructureAssets));
}
