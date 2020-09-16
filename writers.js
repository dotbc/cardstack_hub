const Error = require('@cardstack/plugin-utils/error')
const Session = require('@cardstack/plugin-utils/session')
const log = require('@cardstack/logger')('cardstack/writers')
const { set, get, differenceBy, intersectionBy, partition } = require('lodash')
const { declareInjections } = require('@cardstack/di')
const {
  isCard,
  loadCard,
  getCardId,
  adaptCardToFormat,
  generateInternalCardFormat
} = require('./indexing/card-utils')

module.exports = declareInjections(
  {
    currentSchema: 'hub:current-schema',
    schemaLoader: 'hub:schema-loader',
    searchers: 'hub:searchers',
    pgSearchClient: `plugin-client:${require.resolve(
      '@cardstack/pgsearch/client'
    )}`
  },

  class Writers {
    get schemaTypes () {
      return this.schemaLoader.ownTypes()
    }

    // not using DI to prevent circular dependency
    _getCardServices () {
      if (this.cardServices) {
        return this.cardServices
      }
      return (this.cardServices = this.__owner__.lookup('hub:card-services'))
    }
    async create (session, type, document, softWrite) {
      log.info('creating type=%s', type)
      await this.pgSearchClient.ensureDatabaseSetup()
      if (Array.isArray(document)) {
        const _authorizedDocs = []
        await Promise.all(
          document.map(async doc => {
            const _doc = await this.handleCreate(
              false,
              session,
              type,
              doc,
              undefined,
              softWrite,
              true
            )
            _authorizedDocs.push(_doc)
          })
        )
        const schema = await this.currentSchema.getSchema()
        let { writer } = this._getSchemaDetailsForType(schema, type)
        await writer.bulkPush()
        return _authorizedDocs
      } else {
        if (!document.data) {
          throw new Error(
            'The document must have a top-level "data" property',
            {
              status: 400
            }
          )
        }
        return await this.handleCreate(
          false,
          session,
          type,
          document,
          undefined,
          softWrite
        )
      }
    }

    async createBinary (session, type, stream) {
      log.info('creating type=%s from binary stream', type)
      await this.pgSearchClient.ensureDatabaseSetup()
      if (!stream.read) {
        throw new Error('The passed stream must be a readable binary stream', {
          status: 400
        })
      }

      return await this.handleCreate(true, session, type, stream)
    }

    async handleCardDeleteOperation (session, id) {
      let internalCard
      try {
        internalCard = await this.searchers.get(
          Session.INTERNAL_PRIVILEGED,
          'local-hub',
          id,
          id
        )
      } catch (e) {
        if (e.status !== 404) {
          throw e
        }
      }
      if (!internalCard) {
        return {}
      }

      return await this.handleCardOperations(session, internalCard, true)
    }

    async handleCardOperations (session, card, isDeletion) {
      let schema, internalCard, oldCard
      let id = card.data.id
      if (isDeletion) {
        internalCard = card
        schema = await this._loadInternalCardSchema(internalCard)
      } else {
        ;({ schema, internalCard } = await this._loadInternalCard(card))
        try {
          oldCard = await this.searchers.get(
            Session.INTERNAL_PRIVILEGED,
            'local-hub',
            id,
            id
          )
        } catch (e) {
          if (e.status !== 404) {
            throw e
          }
        }
      }

      let addedModels = []
      let deletedModels = []
      let changedModels = []
      if (isDeletion) {
        deletedModels = [internalCard.data].concat(internalCard.included || [])
      } else if (oldCard) {
        changedModels = intersectionBy(
          internalCard.included || [],
          oldCard.included || [],
          i => `${i.type}/${i.id}`
        )
        addedModels = differenceBy(
          internalCard.included || [],
          oldCard.included || [],
          i => `${i.type}/${i.id}`
        )
        deletedModels = differenceBy(
          oldCard.included || [],
          internalCard.included || [],
          i => `${i.type}/${i.id}`
        )
      } else {
        addedModels = internalCard.included || []
      }

      let beforeFinalize = async () => {
        // This assumes that the session used to update cards also posseses permissions to CRUD schema models and internal card models
        await this.pgSearchClient.ensureDatabaseSetup()
        for (let resource of addedModels) {
          await this.handleCreate(
            false,
            session,
            resource.type,
            {
              data: resource,
              included: [internalCard.data].concat(internalCard.included || [])
            },
            schema
          )
        }
        for (let resource of changedModels) {
          await this.update(
            session,
            resource.type,
            resource.id,
            {
              data: resource,
              included: [internalCard.data].concat(internalCard.included || [])
            },
            schema
          )
        }
      }

      // Don't delete schema until after the card model has been updated so that
      // you don't end up with a content type referring to a missing field
      let afterFinalize = async () => {
        let updatedSchema = await this._deleteInternalCardResources(
          session,
          schema,
          deletedModels
        )
        // deleting card schema can result in deleted schema resource which will need to be shared with the outside world
        return updatedSchema
      }

      return { internalCard, schema, beforeFinalize, afterFinalize }
    }

    async handleCreate (
      isBinary,
      session,
      type,
      documentOrStream,
      schema,
      softWrite,
      isBulk
    ) {
      schema = schema || (await this.currentSchema.getSchema())
      let beforeFinalize
      if (type === 'cards') {
        ;({
          schema,
          internalCard: documentOrStream,
          beforeFinalize
        } = await this.handleCardOperations(session, documentOrStream))
        type = documentOrStream.data.type
      }

      let { writer, sourceId } = this._getSchemaDetailsForType(schema, type)

      let pending
      if (isBinary) {
        let opts = await writer.prepareBinaryCreate(
          session,
          type,
          documentOrStream
        )
        let { originalDocument, finalDocument, finalizer, aborter } = opts
        pending = await this.createPendingChange({
          originalDocument,
          finalDocument,
          finalizer,
          aborter,
          opts
        })
      } else {
        let isSchema = this.schemaTypes.includes(type)
        let opts = await writer.prepareCreate(
          session,
          type,
          this._cleanupBodyData(schema, documentOrStream.data),
          isSchema,
          softWrite
        )
        let { originalDocument, finalDocument, finalizer, aborter } = opts
        pending = await this.createPendingChange({
          originalDocument,
          finalDocument,
          finalizer,
          aborter,
          schema,
          opts
        })
      }

      let context
      try {
        let newSchema = await schema.validate(pending, { type, session })
        schema = newSchema || schema

        if (typeof beforeFinalize === 'function') {
          await beforeFinalize()
        }
        context = await this._finalize(pending, type, schema, sourceId, isBulk)

        let batch = this.pgSearchClient.beginBatch(schema, this.searchers)
        await batch.saveDocument(context)
        await batch.done()

        if (newSchema) {
          this.currentSchema.invalidateCache()
        }
      } finally {
        if (pending) {
          await pending.abort()
        }
      }

      let authorizedDocument = await context.applyReadAuthorization({ session })
      if (isCard(authorizedDocument.data.type, authorizedDocument.data.id)) {
        return await adaptCardToFormat(
          schema,
          session,
          authorizedDocument,
          'isolated',
          this._getCardServices()
        )
      }
      return authorizedDocument
    }

    async _update (session, type, id, document, schema, softWrite, isBulk) {
      log.info('updating type=%s id=%s', type, id)
      if (!document.data) {
        throw new Error('The document must have a top-level "data" property', {
          status: 400
        })
      }
      schema = schema || (await this.currentSchema.getSchema())

      let beforeFinalize
      let afterFinalize
      if (type === 'cards') {
        ;({
          schema,
          internalCard: document,
          beforeFinalize,
          afterFinalize
        } = await this.handleCardOperations(session, document))
        type = document.data.type
      }

      let { writer, sourceId } = this._getSchemaDetailsForType(schema, type)
      let isSchema = this.schemaTypes.includes(type)
      let opts = await writer.prepareUpdate(
        session,
        type,
        id,
        this._cleanupBodyData(schema, document.data),
        isSchema,
        softWrite
      )
      let { originalDocument, finalDocument, finalizer, aborter } = opts
      let pending = await this.createPendingChange({
        originalDocument,
        finalDocument,
        finalizer,
        aborter,
        schema,
        opts
      })

      let context
      try {
        let newSchema = await schema.validate(pending, { type, id, session })
        schema = newSchema || schema

        if (typeof beforeFinalize === 'function') {
          await beforeFinalize()
        }
        context = await this._finalize(pending, type, schema, sourceId, isBulk)

        let batch = this.pgSearchClient.beginBatch(schema, this.searchers)
        await batch.saveDocument(context)
        await batch.done()

        if (typeof afterFinalize === 'function') {
          schema = await afterFinalize()
        }
        if (newSchema) {
          this.currentSchema.invalidateCache()
        }
      } finally {
        if (pending) {
          await pending.abort()
        }
      }

      let authorizedDocument = await context.applyReadAuthorization({ session })
      if (isCard(authorizedDocument.data.type, authorizedDocument.data.id)) {
        return await adaptCardToFormat(
          schema,
          session,
          authorizedDocument,
          'isolated',
          this._getCardServices()
        )
      }
      return authorizedDocument
    }

    async update (session, type, id, document, schema, softWrite) {
      await this.pgSearchClient.ensureDatabaseSetup()
      if (Array.isArray(document)) {
        const _authorizedDocs = []
        await Promise.all(
          document.map(async doc => {
            _authorizedDocs.push(
              await this._update(
                session,
                type,
                doc.data.id,
                doc,
                schema,
                softWrite,
                true
              )
            )
          })
        )
        const _schema = await this.currentSchema.getSchema()
        let { writer } = this._getSchemaDetailsForType(_schema, type)
        await writer.bulkPush()
        return _authorizedDocs
      } else {
        return await this._update(
          session,
          type,
          id,
          document,
          schema,
          softWrite
        )
      }
    }

    async delete (session, version, type, id, schema) {
      log.info('deleting type=%s id=%s', type, id)
      await this.pgSearchClient.ensureDatabaseSetup()

      schema = schema || (await this.currentSchema.getSchema())

      let afterFinalize
      if (type === 'cards') {
        let internalCard
        ;({
          schema,
          internalCard,
          afterFinalize
        } = await this.handleCardDeleteOperation(session, id))
        if (!internalCard) {
          return
        }
        type = internalCard.data.type
        version = get(internalCard, 'data.meta.version')
      }

      let { writer, sourceId } = this._getSchemaDetailsForType(schema, type)
      let isSchema = this.schemaTypes.includes(type)
      let opts = await writer.prepareDelete(
        session,
        version,
        type,
        id,
        isSchema
      )
      let { originalDocument, finalDocument, finalizer, aborter } = opts
      let pending = await this.createPendingChange({
        originalDocument,
        finalDocument,
        finalizer,
        aborter,
        schema,
        opts
      })
      try {
        let newSchema = await schema.validate(pending, { session })
        schema = newSchema || schema
        let context = await this._finalize(pending, type, schema, sourceId, id)

        let batch = this.pgSearchClient.beginBatch(schema, this.searchers)
        await batch.deleteDocument(context)
        await batch.done()

        if (typeof afterFinalize === 'function') {
          schema = await afterFinalize()
        }
        if (newSchema) {
          this.currentSchema.invalidateCache()
        }
      } finally {
        if (pending) {
          await pending.abort()
        }
      }
    }

    async createPendingChange ({
      originalDocument,
      finalDocument,
      finalizer,
      aborter,
      schema,
      opts
    }) {
      schema = schema || (await this.currentSchema.getSchema())
      let type = originalDocument ? originalDocument.type : finalDocument.type
      let contentType = schema.getType(type)
      let sourceId
      if (contentType) {
        sourceId = get(contentType, 'dataSource.id')
      }

      return new PendingChange({
        originalDocument,
        finalDocument,
        finalizer,
        aborter,
        sourceId,
        schema,
        opts,
        searchers: this.searchers
      })
    }

    async _finalize (pending, type, schema, sourceId, id, isBulk) {
      let meta = await pending.finalize(isBulk)
      let { finalDocumentContext } = pending

      if (finalDocumentContext) {
        await finalDocumentContext.updateDocumentMeta(meta)
        return finalDocumentContext
      }

      // This is the scenario where the document is being deleted
      return this.searchers.createDocumentContext({
        id,
        type,
        schema,
        sourceId,
        upstreamDoc: null
      })
    }

    // if any primary card models are included in the deletedResources when we'll
    // update the schema to remove those card model's content types. But the onus
    // will be on the caller to delete the primary card model--which is the signal
    // to the hub to delete the externally facing card itself.
    async _deleteInternalCardResources (session, schema, deletedResources) {
      if (!deletedResources.length) {
        return schema
      }

      let [modelsToDelete, schemaToDelete] = partition(deletedResources, i =>
        getCardId(i.type)
      )
      let [cardModels, internalModels] = partition(modelsToDelete, i =>
        isCard(i.type, i.id)
      )
      for (let resource of internalModels) {
        await this.delete(
          session,
          resource.meta.version,
          resource.type,
          resource.id,
          schema
        )
      }
      let fieldsWithRelatedTypes = schemaToDelete.filter(
        i =>
          i.type === 'fields' &&
          (get(i, 'relationships.related-types.data.length') || 0) > 0
      )
      // remove any related types so we wont be tripped up by deleting an internal card
      // content type that has a field with an internal card related type
      for (let resource of fieldsWithRelatedTypes) {
        set(resource, 'relationships.related-types.data', [])
        let { data: updatedResource } = await this.update(
          session,
          resource.type,
          resource.id,
          { data: resource },
          schema
        )
        let index = schemaToDelete.findIndex(
          i => `${i.type}/${i.id}` === `${resource.type}/${resource.id}`
        )
        schemaToDelete[index] = updatedResource
      }

      if (cardModels.length) {
        schema = await schema.applyChanges(
          cardModels.map(i => ({
            type: 'content-types',
            id: i.id,
            document: null
          }))
        )
      }
      schemaToDelete.sort(sortSchemaForDelete)
      for (let resource of schemaToDelete) {
        await this.delete(
          session,
          resource.meta.version,
          resource.type,
          resource.id,
          schema
        )
      }

      return schema
    }

    async _loadInternalCard (card) {
      let internalCard = generateInternalCardFormat(
        await this.currentSchema.getSchema(),
        card
      )
      return {
        internalCard,
        schema: await this._loadInternalCardSchema(internalCard)
      }
    }

    async _loadInternalCardSchema (internalCard) {
      let schema = await loadCard(
        await this.currentSchema.getSchema(),
        internalCard
      )
      return await (await this.currentSchema.getSchema()).applyChanges(
        schema.map(document => ({
          id: document.id,
          type: document.type,
          document
        }))
      )
    }

    _getSchemaDetailsForType (schema, type) {
      let contentType = schema.getType(type)
      if (
        !contentType ||
        !contentType.dataSource ||
        !contentType.dataSource.writer
      ) {
        log.debug(
          'non-writeable type %s: exists=%s hasDataSource=%s hasWriter=%s',
          type,
          Boolean(contentType),
          Boolean(contentType && contentType.dataSource),
          Boolean(
            contentType &&
              contentType.dataSource &&
              contentType.dataSource.writer
          )
        )

        throw new Error(`"${type}" is not a writable type`, {
          status: 403,
          title: 'Not a writable type'
        })
      }

      let writer = contentType.dataSource.writer
      let sourceId = contentType.dataSource.id
      return { writer, sourceId }
    }

    _cleanupBodyData (schema, data) {
      let doc = schema.withOnlyRealFields(data) // remove computed fields
      return this._createQueryLinks(doc) // convert `cardstack-queries` relationships to links.related
    }

    _createQueryLinks (doc) {
      if (!doc.relationships) {
        return doc
      }

      let activeDoc = doc

      for (let fieldName of Object.keys(doc.relationships)) {
        let relationshipData =
          doc.relationships[fieldName] && doc.relationships[fieldName].data

        if (
          relationshipData &&
          ((relationshipData.length &&
            relationshipData[0].type === 'cardstack-queries') ||
            relationshipData.type === 'cardstack-queries')
        ) {
          if (activeDoc === doc) {
            activeDoc = Object.assign({}, doc)
          }
          if (activeDoc.relationships === doc.relationships) {
            activeDoc.relationships = Object.assign({}, doc.relationships)
          }
          activeDoc.relationships[fieldName].links = {
            related: Array.isArray(relationshipData)
              ? relationshipData[0].id
              : relationshipData.id
          }
          delete activeDoc.relationships[fieldName].data
        }
      }

      return activeDoc
    }
  }
)

class PendingChange {
  constructor ({
    originalDocument,
    finalDocument,
    finalizer,
    aborter,
    searchers,
    sourceId,
    schema,
    opts = {}
  }) {
    if (!searchers || !schema) {
      throw new Error(
        `PendingChange requires 'searchers' and 'schema' arguments.`
      )
    }

    this.originalDocument = originalDocument
    this.finalDocument = finalDocument
    this.serverProvidedValues = new Map()
    this._finalizer = finalizer
    this._aborter = aborter

    if (schema && searchers) {
      if (originalDocument) {
        this.originalDocumentContext = searchers.createDocumentContext({
          type: originalDocument.type,
          schema,
          sourceId,
          id: originalDocument.id,
          upstreamDoc: originalDocument ? { data: originalDocument } : null
        })
      }
      if (finalDocument) {
        this.finalDocumentContext = searchers.createDocumentContext({
          type: finalDocument.type,
          schema,
          sourceId,
          id: finalDocument.id,
          upstreamDoc: finalDocument ? { data: finalDocument } : null
        })
      }
    }

    for (let prop of Object.keys(opts)) {
      if (this[prop] != null) {
        continue
      }
      this[prop] = opts[prop]
    }
  }

  async finalize (isBulk) {
    let finalizer = this._finalizer
    this._finalizer = null
    this._aborter = null
    this.isBulk = isBulk
    if (finalizer) {
      return finalizer.call(null, this)
    }
  }

  async abort () {
    let aborter = this._aborter
    this._finalizer = null
    this._aborter = null
    if (aborter) {
      return aborter.call(null, this)
    }
  }
}

// TODO Probably a better idea would be to refactor JSONAPIFactory to outside of test-support
// and then use that to get the resources ordered by dependency in order to safely delete.
function sortSchemaForDelete ({ type: typeA }, { type: typeB }) {
  if (typeA === 'computed-fields') {
    typeA = 'fields'
  }
  if (typeB === 'computed-fields') {
    typeB = 'fields'
  }

  if (typeA === 'content-types' && typeB === 'fields') {
    return -1
  }
  if (typeA === 'fields' && typeB === 'content-types') {
    return 1
  }
  return 0
}
