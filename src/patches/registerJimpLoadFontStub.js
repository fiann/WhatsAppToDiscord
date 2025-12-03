import * as moduleApi from 'module';

const Module = moduleApi.default ?? moduleApi;
const LOAD_FONT_SPECIFIERS = new Set([
  '@jimp/plugin-print/load-font',
  '@jimp/plugin-print/load-font.js',
  '@jimp/plugin-print/dist/commonjs/load-font',
  '@jimp/plugin-print/dist/commonjs/load-font.js',
]);

const stubbedExports = {
  async loadFont() {
    const error = new Error('Jimp.loadFont() is not available in the packaged build');
    error.code = 'ERR_JIMP_FONT_UNAVAILABLE';
    throw error;
  },
};

const shouldPatch = typeof process !== 'undefined'
  && process.pkg
  && !globalThis.__wa2dcJimpLoadFontPatched;

if (shouldPatch) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (LOAD_FONT_SPECIFIERS.has(request)) {
      return stubbedExports;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  globalThis.__wa2dcJimpLoadFontPatched = true;
}
