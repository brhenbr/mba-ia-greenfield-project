// Jest runs this project as CommonJS, but @nestjs/bullmq and @nestjs/bull-shared
// (v12) are published as ESM only. Node resolves them natively at runtime
// (require(esm)); Jest does not, so these two packages are converted to CJS here.
const ts = require('typescript');

module.exports = {
  process(sourceText, sourcePath) {
    const { outputText } = ts.transpileModule(sourceText, {
      fileName: sourcePath,
      compilerOptions: {
        allowJs: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    });
    return { code: outputText };
  },
};
