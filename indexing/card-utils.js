"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
const error_1 = __importDefault(require("@cardstack/plugin-utils/error"));
const session_1 = __importDefault(require("@cardstack/plugin-utils/session"));
const lodash_1 = require("lodash");
const logger_1 = __importDefault(require("@cardstack/logger"));
const path_1 = require("path");
const os_1 = require("os");
const fs_extra_1 = require("fs-extra");
const cardsDir = path_1.join(os_1.tmpdir(), 'card_modules');
const cardFileName = 'card.js';
const seenVersionsFile = '.seen_versions.json';
const log = logger_1.default('cardstack/card-utils');
const cardIdDelim = '::';
const cardBrowserAssetFields = [
    'isolated-template',
    'isolated-js',
    'isolated-css',
    'embedded-template',
    'embedded-js',
    'embedded-css',
];
const metadataFieldTypesField = 'metadata-field-types';
function cardContextFromId(id) {
    let noContext = {};
    if (id == null) {
        return noContext;
    }
    let idSplit = String(id).split(cardIdDelim);
    if (idSplit.length < 2) {
        return noContext;
    }
    let [repository, packageName, cardId, modelId] = idSplit;
    return {
        repository,
        packageName,
        cardId,
        modelId,
    };
}
function cardContextToId({ repository, packageName, cardId, modelId }) {
    return [repository, packageName, cardId, modelId].filter(i => i != null).join(cardIdDelim);
}
function isCard(type = '', id = '') {
    return id && type === id && id.split(cardIdDelim).length > 2;
}
async function loadCard(schema, card) {
    if (!card || !card.data || !card.data.id) {
        return;
    }
    // a searcher or indexer may be returning invalid cards, so we
    // need to make sure to validate the internal card format.
    validateInternalCardFormat(schema, card);
    await generateCardModule(card);
    return getCardSchemas(schema, card);
}
function getCardId(id) {
    if (id == null) {
        return;
    }
    if (String(id).split(cardIdDelim).length < 3) {
        return;
    }
    let { repository, packageName, cardId } = cardContextFromId(id);
    return cardContextToId({ repository, packageName, cardId });
}
function validateInternalCardFormat(schema, card) {
    let id = card.data.id;
    let type = card.data.type;
    if (!id) {
        throw new error_1.default(`The card ID must be supplied in the card document`, { status: 400, source: { pointer: '/data/id' } });
    }
    if (!type) {
        throw new error_1.default(`The card type must be supplied in the card document`, { status: 400, source: { pointer: '/data/type' } });
    }
    if (id !== type) {
        throw new error_1.default(`The card '${id}' has a card model content-type that does not match its id: '${type}'`, { status: 400, source: { pointer: '/data/id' } });
    }
    let fields = lodash_1.get(card, 'data.relationships.fields.data') || [];
    let foreignFieldIndex = fields.findIndex(i => !(i.id.includes(id)));
    if (foreignFieldIndex > -1) {
        throw new error_1.default(`The card '${id}' uses a foreign field '${fields[foreignFieldIndex].type}/${fields[foreignFieldIndex].id}`, { status: 400, source: { pointer: `/data/relationships/fields/data/${foreignFieldIndex}` } });
    }
    let modelRelationships = Object.keys(lodash_1.get(card, 'data.relationships') || {}).filter(i => i !== 'fields');
    for (let rel of modelRelationships) {
        let linkage = lodash_1.get(card, `data.relationships.${rel}.data`);
        if (!linkage) {
            continue;
        }
        if (Array.isArray(linkage)) {
            let foreignLinkageIndex = linkage.findIndex(i => !isCard(i.type, i.id) && ((!schema.isSchemaType(i.type) && !i.type.includes(id)) || !i.id.includes(id)));
            if (foreignLinkageIndex > -1) {
                throw new error_1.default(`The card '${id}' has a relationship to a foreign internal model '${linkage[foreignLinkageIndex].type}/${linkage[foreignLinkageIndex].id}'`, { status: 400, source: { pointer: `/data/relationships/${rel}/data/${foreignLinkageIndex}` } });
            }
        }
        else {
            if (!isCard(linkage.type, linkage.id) && ((!schema.isSchemaType(linkage.type) && !linkage.type.includes(id)) || !linkage.id.includes(id))) {
                throw new error_1.default(`The card '${id}' has a relationship to a foreign internal model '${linkage.type}/${linkage.id}'`, { status: 400, source: { pointer: `/data/relationships/${rel}/data` } });
            }
        }
    }
    // TODO need validation for included with missing id?
    if (!card.included) {
        return;
    }
    let foreignIncludedIndex = (card.included || []).findIndex(i => !isCard(i.type, i.id) && i.id != null && ((!schema.isSchemaType(i.type) && !i.type.includes(id)) || !i.id.includes(id)));
    if (foreignIncludedIndex > -1) {
        throw new error_1.default(`The card '${id}' contains included foreign internal models '${card.included[foreignIncludedIndex].type}/${card.included[foreignIncludedIndex].id}`, { status: 400, source: { pointer: `/included/${foreignIncludedIndex}` } });
    }
}
function validateExternalCardFormat(card) {
    let id = card.data.id;
    if (!id) {
        throw new error_1.default(`The card ID must be supplied in the card document`, { status: 400, source: { pointer: '/data/id' } });
    }
    if (card.data.type !== 'cards') {
        throw new error_1.default(`The document type for card '${id}' is not 'cards', rather it is '${card.data.type}'`, { status: 400, source: { pointer: '/data/type' } });
    }
    let modelLinkage = lodash_1.get(card, 'data.relationships.model.data');
    if (!modelLinkage) {
        throw new error_1.default(`The card 'cards/${id}' is missing its card model '${id}/${id}'.`, { status: 400, source: { pointer: '/data/relationships/model/data' } });
    }
    if (modelLinkage.type !== id || modelLinkage.id !== id) {
        throw new error_1.default(`For the card '${id}', the card model does not match the card id. The card model is '${modelLinkage.type}/${modelLinkage.id}'`, { status: 400, source: { pointer: '/data/relationships/model/data' } });
    }
    if (!(card.included || []).find(i => `${i.type}/${i.id}` === `${id}/${id}`)) {
        throw new error_1.default(`The specified card model '${id}/${id}' is missing for card '${id}'`, { status: 400, source: { pointer: '/data/relationships/model/data' } });
    }
}
function generateInternalCardFormat(schema, card) {
    let id = card.data.id;
    if (!id) {
        throw new error_1.default(`The card ID must be supplied in the card document in order to create the card.`);
    }
    validateExternalCardFormat(card);
    card = addCardNamespacing(schema, card);
    let model = (card.included || []).find(i => `${i.type}/${i.id}` === `${id}/${id}`);
    if (!model) {
        throw new error_1.default(`The card 'cards/${id}' is missing its card model '${id}/${id}'.`, { status: 400, source: { pointer: '/data/relationships/model/data' } });
    }
    let fields = lodash_1.get(card, 'data.relationships.fields.data') || [];
    lodash_1.set(model, 'relationships.fields.data', fields);
    let version = lodash_1.get(card, 'data.meta.version');
    if (version != null) {
        lodash_1.set(model, 'meta.version', version);
    }
    for (let field of cardBrowserAssetFields) {
        let value = lodash_1.get(card, `data.attributes.${field}`);
        if (!value) {
            continue;
        }
        lodash_1.set(model, `attributes.${field}`, value);
    }
    let nonModelCardResources = lodash_1.cloneDeep((card.included || [])
        .filter(i => model &&
        `${i.type}/${i.id}` !== `${model.type}/${model.id}` &&
        (i.id || '').includes(id)));
    for (let resource of nonModelCardResources.concat(model)) {
        if (!resource.id) {
            continue;
        }
        if (resource.type === 'cards') {
            resource.type = resource.id;
        }
        for (let rel of Object.keys(resource.relationships || {})) {
            let linkage = lodash_1.get(resource, `relationships.${rel}.data`);
            if (Array.isArray(linkage)) {
                lodash_1.set(resource, `relationships.${rel}.data`, linkage.map(i => i.type === 'cards' ? { type: i.id, id: i.id } : { type: i.type, id: i.id }));
            }
            else if (linkage) {
                lodash_1.set(resource, `relationships.${rel}.data`, linkage.type === 'cards' ? { type: linkage.id, id: linkage.id } : { type: linkage.type, id: linkage.id });
            }
        }
    }
    return { data: model, included: nonModelCardResources };
}
// TODO it's possible for cards originating from the same package to have different templates/components
// as a specific card instance could have its schema altered. need to think through how we would represent
// cards that have different components/templates but originate from the same package, or cards
// from the same package but different repositories that have been altered between the different repos.
// Ideally we can leverage the "card adoption" to make simplifying assumptions around cards that share
// similar components/templates, but will also need to be flexible enough to disambiguate cards that have
// differing components/templates that originate from the same package.
async function generateCardModule(card) {
    if (!card || !card.data || !card.data.id) {
        return;
    }
    let { repository, packageName } = cardContextFromId(card.data.id);
    if (!repository || !packageName) {
        return;
    }
    let cleanCard = {
        data: lodash_1.cloneDeep(card.data),
        included: lodash_1.sortBy(card.included, i => `${i.type}/${i.id}`)
    };
    let computedFields = (lodash_1.get(cleanCard, 'data.relationships.fields.data') || [])
        .filter(i => i.type === 'computed-fields').map(i => i.id);
    for (let field of Object.keys(cleanCard.data.attributes || {})) {
        if (!computedFields.includes(field) || !cleanCard.data.attributes) {
            continue;
        }
        delete cleanCard.data.attributes[field];
    }
    for (let field of Object.keys(cleanCard.data.relationships || {})) {
        if (!computedFields.includes(field) || !cleanCard.data.relationships) {
            continue;
        }
        delete cleanCard.data.relationships[field];
    }
    lodash_1.unset(cleanCard, 'data.attributes.metadata-field-types');
    let version = lodash_1.get(cleanCard, 'data.meta.version');
    let cardFolder = path_1.join(cardsDir, repository, packageName);
    let cardFile = path_1.join(cardFolder, cardFileName);
    let seenVersions = [];
    fs_extra_1.ensureDirSync(cardFolder);
    delete cleanCard.data.meta;
    // need to make sure we aren't using cached card module since we use
    // import to load the card.
    if (fs_extra_1.pathExistsSync(cardFile)) {
        for (let cacheKey of Object.keys(require.cache)) {
            if (!cacheKey.includes(cardFile)) {
                continue;
            }
            delete require.cache[cacheKey];
        }
        let cardOnDisk = (await Promise.resolve().then(() => __importStar(require(cardFile)))).default;
        // cleanup default value field artifacts
        for (let field of Object.keys(cardOnDisk.data.attributes || {})) {
            if (cardOnDisk.data.attributes && cardOnDisk.data.attributes[field] == null) {
                delete cardOnDisk.data.attributes[field];
            }
        }
        for (let field of Object.keys(cleanCard.data.attributes || {})) {
            if (cleanCard.data.attributes && cleanCard.data.attributes[field] == null) {
                delete cleanCard.data.attributes[field];
            }
        }
        if (lodash_1.isEqual(cleanCard.data, cardOnDisk.data)) {
            return;
        }
        try {
            seenVersions = fs_extra_1.readJSONSync(path_1.join(cardFolder, seenVersionsFile));
        }
        catch (e) {
            if (e.code !== 'ENOENT') {
                throw e;
            } // ignore file not found errors
        }
        // the PendingChange class will actually create DocumentContext for the old
        // and new versions of the document when it is being updated, and we dont want
        // to inadvertantly clobber the latest card on disk with an older version of
        // the card as a result of processing an older card as part of what PendingChange
        // needs to do, so we keep track of the versions of the card that we've seen and
        // only write to disk if the version of the card is not one we have encountered yet.
        if (version != null && seenVersions.includes(version)) {
            return;
        }
    }
    log.info(`generating on-disk card artifacts for cards/${card.data.id} in ${cardFolder}`);
    createPkgFile(cleanCard, cardFolder);
    createBrowserAssets(cleanCard, cardFolder);
    // TODO link peer deps and create entry points.
    // I'm punting on this for now, as custom card components are not a
    // top priority at the moment. Linking peer deps and creating
    // entry points makes assumptions around a shared file system between
    // ember-cli's node and the hub, as well as it requires that the cardhost
    // ember-cli build actually occur before this function is called (in
    // order to link peer deps), as we leverage the embroider app dir from
    // the build in order to link peer deps. For the node-tests this will
    // be a bit tricky. I think the easiest thing would be to mock an
    // ember-cli build of the card host for node-tests by creating an
    // .embroider-build-path file that just points to the root project
    // folder (which would be the parent of the yarn workspace's
    // node_modules folder).
    // TODO in the future `yarn install` this package
    fs_extra_1.writeFileSync(cardFile, `module.exports = ${JSON.stringify(cleanCard, null, 2)};`, 'utf8');
    if (version != null) {
        seenVersions.push(version);
        fs_extra_1.writeJSONSync(path_1.join(cardFolder, seenVersionsFile), seenVersions);
    }
    // TODO in the future we should await until webpack finishes compiling
    // the browser assets however we determine to manage that...
}
function createBrowserAssets(card, cardFolder) {
    if (!card.data.attributes) {
        return;
    }
    for (let field of cardBrowserAssetFields) {
        let content = card.data.attributes[field];
        content = (content || '').trim();
        let [assetType, extension] = field.split('-');
        extension = extension === 'template' ? 'hbs' : extension;
        let file = path_1.join(cardFolder, `${assetType}.${extension}`);
        if (!content) {
            log.debug(`ensuring browser asset doesn't exist for cards/${card.data.id} at ${file}`);
            fs_extra_1.removeSync(file);
        }
        else {
            log.debug(`generating browser asset for cards/${card.data.id} at ${file}`);
            fs_extra_1.writeFileSync(file, content, 'utf8');
        }
    }
}
function createPkgFile(card, cardFolder) {
    if (!card.data.id) {
        return;
    }
    let { packageName: name } = cardContextFromId(card.data.id);
    let version = '0.0.0'; // TODO deal with version numbers
    log.debug(`generating package.json for cards/${card.data.id} at ${path_1.join(cardFolder, 'package.json')}`);
    let pkg = {
        name,
        version,
        // TODO grab peer deps from the card document instead of hard coding here
        "peerDependencies": {
            "@glimmer/component": "*"
        }
    };
    fs_extra_1.writeFileSync(path_1.join(cardFolder, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
    return pkg;
}
function getCardSchemas(schema, card) {
    if (!card) {
        return;
    }
    if (!card.data.id) {
        return;
    }
    let schemaModels = [];
    for (let resource of (card.included || [])) {
        if (!schema.isSchemaType(resource.type)) {
            continue;
        }
        schemaModels.push(resource);
    }
    let cardModelSchema = deriveCardModelContentType(card);
    if (cardModelSchema) {
        schemaModels.push(cardModelSchema);
    }
    return schemaModels;
}
function deriveCardModelContentType(card) {
    if (!card.data.id) {
        return;
    }
    let id = getCardId(card.data.id);
    let fields = {
        data: [{ type: 'fields', id: 'fields' }].concat(cardBrowserAssetFields.map(i => ({ type: 'fields', id: i })), lodash_1.get(card, 'data.relationships.fields.data') || [], [{ type: 'computed-fields', id: 'metadata-field-types' }])
    };
    // not checking field-type, as that precludes using computed relationships for meta
    // which should be allowed. this will result in adding attr fields here, but that should be harmless
    let defaultIncludes = [
        'fields',
        'fields.related-types',
        'fields.constraints',
    ].concat((lodash_1.get(card, 'data.relationships.fields.data') || [])
        .map((i) => i.id));
    let modelContentType = {
        id,
        type: 'content-types',
        attributes: { 'default-includes': defaultIncludes },
        relationships: { fields }
    };
    return modelContentType;
}
async function adaptCardCollectionToFormat(schema, session, collection, format, cardServices) {
    let included = [];
    let data = [];
    for (let resource of collection.data) {
        if (!isCard(resource.type, resource.id)) {
            data.push(resource);
            continue;
        }
        let { data: cardResource, included: cardIncluded = [] } = await adaptCardToFormat(schema, session, { data: resource, included: collection.included }, format, cardServices);
        included = included.concat(cardIncluded);
        data.push(cardResource);
    }
    let rootItems = data.map(i => `${i.type}/${i.id}`);
    included = lodash_1.uniqBy(included.filter(i => !rootItems.includes(`${i.type}/${i.id}`)), j => `${j.type}/${j.id}`)
        .map(i => {
        if (isCard(i.type, i.id)) {
            i.type = 'cards';
        }
        return i;
    });
    let document = { data };
    if (included.length) {
        document.included = included;
    }
    return document;
}
async function adaptCardToFormat(schema, session, cardModel, format, cardServices) {
    if (!cardModel.data || !cardModel.data.id) {
        throw new error_1.default(`Cannot load card with missing id.`);
    }
    let id = cardModel.data.id;
    cardModel.data.attributes = cardModel.data.attributes || {};
    // we need to make sure that grants don't interfere with our ability to get the card schema
    let priviledgedCard;
    if (session !== session_1.default.INTERNAL_PRIVILEGED) {
        try {
            priviledgedCard = await cardServices.get(session_1.default.INTERNAL_PRIVILEGED, id, 'isolated');
        }
        catch (e) {
            if (e.status !== 404) {
                throw e;
            }
        }
    }
    if (priviledgedCard) {
        priviledgedCard = generateInternalCardFormat(schema, priviledgedCard);
    }
    priviledgedCard = priviledgedCard || cardModel;
    let cardSchema = getCardSchemas(schema, priviledgedCard) || [];
    schema = await schema.applyChanges(cardSchema.map(document => ({ id: document.id, type: document.type, document })));
    let result = {
        data: {
            id,
            type: 'cards',
            attributes: {},
            relationships: {
                fields: lodash_1.get(cardModel, 'data.relationships.fields'),
                model: {
                    data: { type: cardModel.data.type, id: cardModel.data.id }
                }
            }
        },
        included: []
    };
    if (cardModel.data.meta) {
        result.data.meta = cardModel.data.meta;
    }
    let attributes = {};
    for (let attr of Object.keys(cardModel.data.attributes)) {
        if (cardBrowserAssetFields.concat([metadataFieldTypesField]).includes(attr) && result.data.attributes) {
            result.data.attributes[attr] = cardModel.data.attributes[attr];
        }
        else {
            attributes[attr] = cardModel.data.attributes[attr];
        }
    }
    let relationships = {};
    for (let rel of Object.keys(cardModel.data.relationships || {})) {
        if (rel === 'fields' || !cardModel.data.relationships) {
            continue;
        }
        let linkage = lodash_1.get(cardModel, `data.relationships.${rel}.data`);
        if (Array.isArray(linkage)) {
            relationships[rel] = {
                data: linkage.map(i => isCard(i.type, i.id) ? ({ type: 'cards', id: i.id }) : ({ type: i.type, id: i.id }))
            };
        }
        else if (linkage) {
            relationships[rel] = {
                data: isCard(linkage.type, linkage.id) ? ({ type: 'cards', id: linkage.id }) : ({ type: linkage.type, id: linkage.id })
            };
        }
    }
    let model = {
        id,
        type: id,
        attributes,
        relationships
    };
    if (format === 'isolated') {
        result.included = [model].concat((cardModel.included || []).filter(i => schema.isSchemaType(i.type)));
    }
    for (let { id: fieldId } of (lodash_1.get(priviledgedCard, 'data.relationships.fields.data') || [])) {
        let { modelId: fieldName } = cardContextFromId(fieldId);
        if (!fieldName) {
            continue;
        }
        let field = schema.getRealAndComputedField(fieldId);
        if (formatHasField(field, format)) {
            let fieldAttrValue = lodash_1.get(model, `attributes.${fieldId}`);
            let fieldRelValue = lodash_1.get(model, `relationships.${fieldId}.data`);
            if (!field.isRelationship && fieldAttrValue !== undefined && result.data.attributes) {
                result.data.attributes[fieldName] = fieldAttrValue;
            }
            else if (field.isRelationship && fieldRelValue && result.data.relationships && result.included) {
                result.data.relationships[fieldName] = { data: lodash_1.cloneDeep(fieldRelValue) };
                let includedResources = [];
                if (Array.isArray(fieldRelValue)) {
                    let relRefs = fieldRelValue.map((i) => `${i.type}/${i.id}`);
                    includedResources = cardModel.included ?
                        cardModel.included.filter(i => (isCard(i.type, i.id) ? relRefs.includes(`cards/${i.id}`) : relRefs.includes(`${i.type}/${i.id}`))) : [];
                }
                else {
                    let includedResource = cardModel.included && cardModel.included.find(i => fieldRelValue != null &&
                        !Array.isArray(fieldRelValue) &&
                        `${i.type}/${i.id}` === `${fieldRelValue.type === 'cards' ? fieldRelValue.id : fieldRelValue.type}/${fieldRelValue.id}`);
                    if (includedResource) {
                        includedResources = [includedResource];
                    }
                }
                let resolvedIncluded = [];
                for (let resource of includedResources) {
                    if (!resource.id) {
                        continue;
                    }
                    if (!isCard(resource.type, resource.id)) {
                        resolvedIncluded.push(resource);
                    }
                    else {
                        let { data: cardResource, included = [] } = await cardServices.get(session, resource.id, 'embedded');
                        resolvedIncluded.push(cardResource, ...included.filter((i) => i.type === 'cards'));
                    }
                }
                result.included = result.included.concat(resolvedIncluded);
            }
        }
        else {
            lodash_1.unset(result, `data.attributes.${metadataFieldTypesField}.${fieldName}`);
        }
    }
    result.included = lodash_1.uniqBy(result.included, i => `${i.type}/${i.id}`);
    return removeCardNamespacing(result);
}
// TODO in the future as part of supporting card adoption, we'll likely need to
// preserve the namespacing of adopted card fields in the external card document
function removeCardNamespacing(card) {
    let id = card.data.id;
    if (!id) {
        return;
    }
    let resultingCard = lodash_1.cloneDeep(card);
    for (let resource of [resultingCard.data].concat(resultingCard.included || [])) {
        if (resource.type !== 'cards' && !isCard(resource.type, resource.id)) {
            resource.type = getCardId(resource.type) ? cardContextFromId(resource.type).modelId : resource.type;
            resource.id = getCardId(resource.id) && resource.id != null ? cardContextFromId(resource.id).modelId : resource.id;
        }
        for (let field of Object.keys(resource.attributes || {})) {
            let { modelId: fieldName } = cardContextFromId(field);
            if (!fieldName || !resource.attributes) {
                continue;
            }
            resource.attributes[fieldName] = resource.attributes[field];
            delete resource.attributes[field];
        }
        for (let field of Object.keys(resource.relationships || {})) {
            let { modelId: fieldName } = cardContextFromId(field);
            if (!resource.relationships ||
                (field === 'model' && resource.type === 'cards')) {
                continue;
            }
            if (fieldName) {
                resource.relationships[fieldName] = resource.relationships[field];
                delete resource.relationships[field];
            }
            else {
                fieldName = field;
            }
            let linkage = lodash_1.get(resource, `relationships.${fieldName}.data`);
            if (Array.isArray(linkage)) {
                lodash_1.set(resource, `relationships.${fieldName}.data`, linkage.map(i => ({
                    type: i.type !== 'cards' && getCardId(i.type) ? cardContextFromId(i.type).modelId : i.type,
                    id: i.type !== 'cards' && getCardId(i.id) ? cardContextFromId(i.id).modelId : i.id,
                })));
            }
            else if (linkage) {
                let linkageType = linkage.type !== 'cards' && getCardId(linkage.type) ? cardContextFromId(linkage.type).modelId : linkage.type;
                let linkageId = linkage.type !== 'cards' && getCardId(linkage.id) ? cardContextFromId(linkage.id).modelId : linkage.id;
                lodash_1.set(resource, `relationships.${fieldName}.data`, { type: linkageType, id: linkageId });
            }
        }
    }
    return resultingCard;
}
function addCardNamespacing(schema, card) {
    let id = getCardId(card.data.id);
    if (!id) {
        return;
    }
    let resultingCard = lodash_1.cloneDeep(card);
    for (let resource of [resultingCard.data].concat(resultingCard.included || [])) {
        let isSchemaModel = schema.isSchemaType(resource.type);
        if (resource.type !== 'cards' && !isCard(resource.type, resource.id)) {
            resource.type = schema.isSchemaType(resource.type) ? resource.type : `${id}${cardIdDelim}${resource.type}`;
            resource.id = `${id}${cardIdDelim}${resource.id}`;
        }
        if (!isSchemaModel && resource.type !== 'cards') {
            for (let field of Object.keys(resource.attributes || {})) {
                if (!resource.attributes) {
                    continue;
                }
                let fieldName = `${id}${cardIdDelim}${field}`;
                resource.attributes[fieldName] = resource.attributes[field];
                delete resource.attributes[field];
            }
        }
        for (let field of Object.keys(resource.relationships || {})) {
            if (!resource.relationships || (resource.type === 'cards' && field === 'model')) {
                continue;
            }
            let fieldName = isSchemaModel || resource.type === 'cards' ? field : `${id}${cardIdDelim}${field}`;
            if (!isSchemaModel && resource.type !== 'cards') {
                resource.relationships[fieldName] = resource.relationships[field];
                delete resource.relationships[field];
            }
            let linkage = lodash_1.get(resource, `relationships.${fieldName}.data`);
            if (Array.isArray(linkage)) {
                lodash_1.set(resource, `relationships.${fieldName}.data`, linkage.map(i => ({
                    type: schema.isSchemaType(i.type) || i.type === 'cards' ? i.type : `${id}${cardIdDelim}${i.type}`,
                    id: i.type !== 'cards' ? `${id}${cardIdDelim}${i.id}` : i.id,
                })));
            }
            else if (linkage) {
                let linkageType = schema.isSchemaType(linkage.type) || linkage.type === 'cards' ? linkage.type : `${id}${cardIdDelim}${linkage.type}`;
                let linkageId = linkage.type !== 'cards' ? `${id}${cardIdDelim}${linkage.id}` : linkage.id;
                lodash_1.set(resource, `relationships.${fieldName}.data`, { type: linkageType, id: linkageId });
            }
        }
    }
    return resultingCard;
}
function formatHasField(field, format) {
    if (!field.isMetadata) {
        return false;
    }
    if (format === 'embedded' && !field.neededWhenEmbedded) {
        return false;
    }
    return true;
}
module.exports = {
    isCard,
    loadCard,
    getCardId,
    adaptCardToFormat,
    cardBrowserAssetFields,
    generateInternalCardFormat,
    adaptCardCollectionToFormat,
};
//# sourceMappingURL=card-utils.js.map