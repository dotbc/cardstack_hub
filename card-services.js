"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const di_1 = require("@cardstack/di");
const card_utils_1 = __importDefault(require("./indexing/card-utils"));
const { adaptCardToFormat, adaptCardCollectionToFormat } = card_utils_1.default;
module.exports = di_1.declareInjections({
    writers: 'hub:writers',
    searchers: 'hub:searchers',
    currentSchema: 'hub:current-schema'
}, class CardServices {
    async get(session, id, format) {
        let card = await this.searchers.get(session, 'local-hub', id, id, { format });
        return await adaptCardToFormat(await this.currentSchema.getSchema(), session, card, format, this);
    }
    async search(session, format, query) {
        let cards = await this.searchers.search(session, query, { format });
        return await adaptCardCollectionToFormat(await this.currentSchema.getSchema(), session, cards, format, this);
    }
    async create(session, card) {
        return await this.writers.create(session, 'cards', card);
    }
    async update(session, id, card) {
        return await this.writers.update(session, 'cards', id, card);
    }
    async delete(session, id, version) {
        return await this.writers.delete(session, version, 'cards', id);
    }
});
//# sourceMappingURL=card-services.js.map