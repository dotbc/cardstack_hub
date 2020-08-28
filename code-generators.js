"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const di_1 = require("@cardstack/di");
const logger_1 = __importDefault(require("@cardstack/logger"));
const log = logger_1.default('cardstack/code-gen');
module.exports = di_1.declareInjections({
    plugins: 'hub:plugins'
}, class CodeGenerators {
    async generateCode() {
        log.debug(`Running code generators`);
        let modules = new Map();
        let appModules = new Map();
        let activePlugins = await this.plugins.active();
        for (let feature of activePlugins.featuresOfType('code-generators')) {
            log.debug(`Running code generator %s `, feature.id);
            let codeGenerator = activePlugins.lookupFeatureAndAssert('code-generators', feature.id);
            if (typeof codeGenerator.generateModules === 'function') {
                for (let [moduleName, source] of await codeGenerator.generateModules()) {
                    let packageName = feature.relationships.plugin.data.id;
                    modules.set(`${packageName}/${moduleName}`, source);
                }
            }
            if (typeof codeGenerator.generateAppModules === 'function') {
                for (let item of await codeGenerator.generateAppModules()) {
                    appModules.set(...item);
                }
            }
        }
        return { modules, appModules };
    }
});
//# sourceMappingURL=code-generators.js.map