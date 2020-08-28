// This implements the public interface that allows user-provided code
// (like computed fields) to access models.
const priv = new WeakMap();
const qs = require('qs');
const {
  isCard,
  loadCard,
} = require('./indexing/card-utils');

exports.privateModels = priv;

function isRelationshipObject(obj) {
  // json:api spec says you're also a valid relationship object if you have
  // only a "meta" property, but we don't really use that case, so we're not
  // including it here.
  return obj && (
    obj.hasOwnProperty('links') ||
    obj.hasOwnProperty('data')
  );
}

exports.Model = class Model {
  constructor(contentType, jsonapiDoc, schema, read, getCard, search) {
    priv.set(this, { contentType, jsonapiDoc, schema, read, getCard, search });
  }

  get id() {
    return priv.get(this).jsonapiDoc.id;
  }

  get type() {
    return priv.get(this).jsonapiDoc.type;
  }

  get schema() {
    return priv.get(this).schema;
  }

  getContentType() {
    return priv.get(this).contentType;
  }

  getMeta() {
    let { jsonapiDoc } = priv.get(this);
    if (jsonapiDoc) {
      return jsonapiDoc.meta;
    }
  }

  async getField(fieldName) {
    let { contentType, jsonapiDoc } = priv.get(this);
    let field = contentType.realAndComputedFields.get(fieldName);
    if (!field) {
      throw new Error(`tried to access nonexistent field ${fieldName}`);
    }
    let computedField = contentType.computedFields.get(field.id);
    if (computedField) {
      let userValue = await computedField.compute(this);
      if (field.isRelationship && !isRelationshipObject(userValue)) {
        userValue = { data: userValue };
      }
      return userValue;
    } else if (field.isRelationship) {
      if (jsonapiDoc.relationships) {
        return jsonapiDoc.relationships[field.id];
      }
    } else if (field.id === 'id' || field.id === 'type') {
      return jsonapiDoc[field.id];
    } else {
      return jsonapiDoc.attributes && jsonapiDoc.attributes[field.id];
    }
  }

  async getRelated(fieldName) {
    let relObj = await this.getField(fieldName);
    let { contentType } = priv.get(this);
    let field = contentType.realAndComputedFields.get(fieldName);
    let isCollection = field.fieldType === '@cardstack/core-types::has-many';

    if (relObj && relObj.hasOwnProperty('links') && relObj.links.related) {
      let models = await this.getModels(qs.parse(relObj.links.related.split('/api?')[1]));
      if (isCollection) {
        return models;
      } else {
        return models[0];
      }
    }

    if (relObj && relObj.data) {
      let refs = relObj.data;
      if (Array.isArray(refs)) {
        return (await Promise.all(refs.map(ref => this.getModel(ref.type, ref.id)))).filter(Boolean);
      } else {
        return this.getModel(refs.type, refs.id);
      }
    }

    if (isCollection) {
      return [];
    } else {
      return null;
    }

  }

  async getModel(type, id) {
    let contentType;
    let model;
    let { schema, read, search, jsonapiDoc, getCard } = priv.get(this);
    if (isCard(type, id)) {
      let card = await getCard(id);
      if (!card) { return; }

      let cardSchema = await loadCard(schema, card);
      schema = await schema.applyChanges(cardSchema.map(document => ({ id: document.id, type: document.type, document })));
      priv.get(this).schema = schema;

      contentType = schema.getType(type);
      if (!contentType) {
        throw new Error(`${jsonapiDoc.type} ${jsonapiDoc.id} tried to getModel nonexistent type ${type}`);
      }
      model = card.data;
    } else {
      contentType = schema.getType(type);
      if (!contentType) {
        throw new Error(`${jsonapiDoc.type} ${jsonapiDoc.id} tried to getModel nonexistent type ${type}`);
      }
      model = await read(type, id);
    }
    if (!model) { return; }

    return new Model(contentType, model, schema, read, getCard, search);
  }

  async getModels(query) {
    let { schema, search, read, getCard } = priv.get(this);

    let models = await search(query);
    if (!models) { return; }

    return models.data.map(model => new Model(schema.getType(model.type), model, schema, read, getCard, search));
  }
};
