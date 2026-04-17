// Preload shim: stubs keytar so the smoke test can load crypto.ts on Linux
// where the prebuilt Windows binary ELF-fails. Not used at runtime — only
// wired in via `ts-node -r ./smoke-keytar-stub.js`.
const Module = require('module')
const path = require('path')

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'keytar') {
    return path.resolve(__dirname, 'smoke-keytar-stub.js')
  }
  return origResolve.call(this, request, parent, ...rest)
}

module.exports = {
  default: {
    async getPassword() { return null },
    async setPassword() {},
    async deletePassword() { return true },
    async findCredentials() { return [] },
  },
  async getPassword() { return null },
  async setPassword() {},
  async deletePassword() { return true },
  async findCredentials() { return [] },
}
