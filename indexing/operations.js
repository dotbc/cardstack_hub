"use strict";
const opsPrivate = new WeakMap();
function getPriv(instance) {
    // safe because we always populate opsPrivate at construction
    return opsPrivate.get(instance);
}
class Operations {
    static create(sourcesUpdate, sourceId) {
        return new this(sourcesUpdate, sourceId);
    }
    constructor(sourcesUpdate, sourceId) {
        opsPrivate.set(this, {
            sourceId,
            sourcesUpdate,
            nonce: null
        });
    }
    async save(type, id, doc) {
        let { sourceId, sourcesUpdate, nonce } = getPriv(this);
        await sourcesUpdate.add(type, id, doc, sourceId, nonce);
    }
    async delete(type, id) {
        let { sourcesUpdate } = getPriv(this);
        await sourcesUpdate.delete(type, id);
    }
    async beginReplaceAll() {
        getPriv(this).nonce = Math.floor(Number.MAX_SAFE_INTEGER * Math.random());
    }
    async finishReplaceAll() {
        let { sourcesUpdate, sourceId, nonce } = getPriv(this);
        if (!nonce) {
            throw new Error("tried to finishReplaceAll when there was no beginReplaceAll");
        }
        await sourcesUpdate.deleteAllWithoutNonce(sourceId, nonce);
    }
}
module.exports = Operations;
//# sourceMappingURL=operations.js.map