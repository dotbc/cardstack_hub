const log = require('@cardstack/logger')('cardstack/routers');
const { declareInjections } = require('@cardstack/di');
const Error = require('@cardstack/plugin-utils/error');
const Session = require('@cardstack/plugin-utils/session');
const defaultRouter = require('@cardstack/routing/cardstack/default-router');
const { getRoute, isCanonicalRoute } = require('@cardstack/routing/cardstack');
const { sortBy, uniqBy, get, groupBy } = require('lodash');

const maxRouteDepth = 50;
const notFoundErrorCardId = 'not-found';

module.exports = declareInjections({
  currentSchema: 'hub:current-schema',
  searchers: 'hub:searchers',
},

class Routers {
  // Lazily loading this as running this in the constructor runs into the
  // situation where the searchers are not ready yet. Is there a better way to know when
  // the searcher is ready so we can set this up outside of a user request?
  async getRoutersInfo() {
    if (this.routerMap && this.applicationCard) {
      return { routerMap: this.routerMap, applicationCard: this.applicationCard, routerMapByDepth: this.routerMapByDepth };
    }

    let schema = await this.currentSchema.getSchema();
    let applicationCard = await this._getApplicationCard();

    this.routerMap = this._discoverRouters(schema, applicationCard.data.type);
    this.routerMapByDepth = groupBy(this.routerMap, route => route.routeStack.length);
    this.applicationCard = applicationCard;

    log.debug(`Generated router map: ${JSON.stringify(this.routerMap, null, 2)}`);

    return { routerMap: this.routerMap, applicationCard: this.applicationCard, routerMapByDepth: this.routerMapByDepth };
  }

  async getSpace(path, session={}) {
    await this.getRoutersInfo();

    let schema = await this.currentSchema.getSchema();

    let primaryCard, errorReason;
    let routeInfo = await getRoute(this.searchers, this.routerMap, path, this.applicationCard, session);
    let { params={}, allowedQueryParams=[], routingCard, matchedRoute, remainingPath, query, routeStack=[] } = routeInfo || {};

    if (!routeInfo) {
      errorReason = `Can not find route for path '${path}' for session ${session.type}/${session.id}`;
      primaryCard = await this._getNotFoundErrorCard(schema);
    } else {
      let { data: cards, included } = query ?
        await this.searchers.search(Session.INTERNAL_PRIVILEGED, query) :
        { data: [routingCard.data], included: routingCard.included };

      if (!cards || !cards.length) {
        errorReason = `Can not find card for route '${matchedRoute.path}' with path '${path}' for session ${session.type}/${session.id} using query ${JSON.stringify(query)}`;
        primaryCard = await this._getNotFoundErrorCard(schema, matchedRoute);
      } else if (hasUnconsumedPath(remainingPath, { data: cards[0]})) {
        errorReason = `Path is unconsumed for route '${matchedRoute.path}' with path '${path}' for session ${session.type}/${session.id} remaining path is '${remainingPath}'`;
        primaryCard = await this._getNotFoundErrorCard(schema, matchedRoute);
      } else {
        primaryCard = { data: cards[0], included };
      }
    }

    let included = [ primaryCard.data ].concat(primaryCard.included || []);
    if (get(primaryCard, 'data.meta.is-error-card')) {
      params = { path };
      if (session.id && session.type) {
        params.session = { id: session.id, type: session.type };
      }
    }

    let space = {
      data: {
        id: path,
        type: 'spaces',
        attributes: {
          params,
          'allowed-query-params': get(primaryCard, 'data.meta.is-error-card') ? [] : allowedQueryParams,
          'route-stack': routeStack,
        },
        relationships: {
          'primary-card': {
            data: { type: primaryCard.data.type, id: primaryCard.data.id }
          }
        },
      },
      included
    };

    log.debug(`Routing path '${path}' for session '${session.type}/${session.id}' to space: ${JSON.stringify(space, null, 2)}`);
    if (errorReason) {
      log.debug(`Routing to path '${path}' for session '${session.type}/${session.id}' resulted in error card. Reason: ${errorReason}`);
    }

    return space;
  }

  /*
  router map looks like:

  [{
    contentType: '...'       // content type of the routing card that uses this route
    path: '...',             // full path including the mount point for the route
    namespacedPath: '...',   // full path including the mount point for the route, where we add a content type namespace to the replacement tags
    routePathSegment: '...', // the path of just the route's segment
    query: { ... },
    additionalParams: { ... },

    routeStack: [
      // route of the card that routes to this route
      {
        contentType: '...'
        path: '...',
        namespacedPath: '...', // full path including the mount point for the route, where we add a content type namespace to the replacement tags
        query: { ... }
      },
      .
      .
      // route from application card's router (root), the highest level canonical route appears at the end
      {
        contentType: '...'
        path: '...',
        namespacedPath: '...', // full path including the mount point for the route, where we add a content type namespace to the replacement tags
        query: { ... },
      },
    ]
  }]
  */
  _discoverRouters(schema, routingCardType, routeStack=[]) {
    if (routeStack.length > maxRouteDepth) {
      throw new Error(`Recursed through more than ${maxRouteDepth} routers when building routing map. Router stack: ${JSON.stringify(routeStack, null, 2)}`);
    }

    let type = schema.getType(routingCardType);
    let router = type && type.router;
    if (!router && routeStack.length === 0) {
      router = defaultRouter;
    } else if (!router) {
      return [];
    }

    let routerMap = [];
    let pluckedRoutes = [];
    for (let route of router) {
      let { path, query } = route;
      if (!path) { throw new Error(`The router for content type '${routingCardType}' has a route that is missing a path.`); }
      if (path.charAt(0) !== '/') { throw new Error(`The path of the route for content type '${routingCardType}' at path '${path}' does not begin with '/'.`); }

      if (!isCanonicalRoute(route)) { continue; }

      let namespacedPath = joinPath(buildNameSpacedPathFromRouteStack(routeStack), path) || '/';
      let childRouteStack = [{ path, query, contentType: routingCardType, namespacedPath }].concat(routeStack);
      let routingCardTypeQueryValue = get(route, 'query.filter.type.exact');

      if (routingCardTypeQueryValue && routingCardTypeQueryValue.charAt(0) === ':') {
        let parentTypes = childRouteStack.map(i => i.contentType);
        for (let contentType of schema.getTypes().keys()) {
          // dont crawl any types that are in the route stack, or you'll get trapped in a cycle
          if (parentTypes.includes(contentType)) { continue; }

          routerMap = routerMap.concat(this._discoverRouters(
            schema,
            contentType,
            childRouteStack
          ));
        }
      } else {
        let discoveredRouters = this._discoverRouters( schema, routingCardTypeQueryValue, childRouteStack);

        if (discoveredRouters.length) {
          // pruning interior nodes of the route tree, we only care about the leaf nodes
          pluckedRoutes.push(path);
        }
        routerMap = routerMap.concat(discoveredRouters);
      }
    }

    routerMap = router.filter(route => !pluckedRoutes.includes(route.path)).map(route => {
      return {
        contentType: routingCardType,
        path: joinPath(buildPathFromRouteStack(routeStack), route.path) || '/',
        namespacedPath: joinPath(buildNameSpacedPathFromRouteStack(routeStack), route.path) || '/',
        routePathSegment: route.path,
        query: route.query,
        additionalParams: route.additionalParams,
        routeStack: [].concat(routeStack)
      };
    }).concat(routerMap);

    if (routeStack.length === 0) {
      // sorting the routes by the most specific paths first, so that we match those first
      routerMap = sortBy(uniqBy(routerMap, 'path'),[
        route => route.path === '/' ? 1 : 0,
        route => -1 * route.path.split('/').length,
        route => -1 * route.path.split('?').length,
        route => -1 * route.path.split('&').length,
        route => -1 * route.routeStack.length,
      ]);
    }

    return routerMap;
  }

  async _getApplicationCard() {
    let id, type, config;
    try {
      // TODO assume schema models are cards
      config = (await this.searchers.get(Session.INTERNAL_PRIVILEGED, 'local-hub', 'plugin-configs', '@cardstack/hub')).data;
    } catch (err) {
      if (err.status !== 404) { throw err; }
    }

    if (config) {
      id = get(config, 'attributes.plugin-config.application-card.id');
      type = get(config, 'attributes.plugin-config.application-card.type');
    }

    if (id && type) {
      let appCard = await this.searchers.get(Session.INTERNAL_PRIVILEGED, 'local-hub', type, id);
      if (appCard) {
        return appCard;
      }
    }

    return { data: { type: 'application-cards', id: 'getting-started' } };
  }

  async _getErrorCard(schema, route, errorCardId) {
    let typeStack = route && route.routeStack ? [ route.contentType ].concat(route.routeStack.map(r => r.contentType)) : [];
    for (let type of typeStack) {
      let errorType = `${type}-errors`;
      let errorContentType = schema.getType(errorType);
      if (errorContentType) {
        // we check that the error card has an open grant, otherwise revert to system error card
        // we dont want to potentially swallow errors due to restrive grant settings, so err on the side of caution
        if (!(await errorContentType.authorizedReadRealms()).includes('groups/everyone')) {
          log.warn(`The error card content-type '${errorType}' does not have a read grant for groups/everyone. Not using this error card.`);
        } else {
          let errorCard;
          try {
            errorCard = await this.searchers.get(Session.INTERNAL_PRIVILEGED, 'local-hub', errorType, errorCardId);
          } catch (err) {
            if (err.status !== 404) { throw err; }
          }

          if (errorCard) {
            errorCard = errorCard.data;
            errorCard.meta = errorCard.meta || {};
            errorCard.meta['is-error-card'] = true;

            return errorCard;
          } else {
            log.warn(`The error card ${errorType}/${errorCardId} does not exist.`);
          }
        }
      }
    }
    return {
      type: 'error-cards', id: errorCardId,
      meta: { 'is-error-card': true }
    };
  }

  async _getNotFoundErrorCard(schema, route) {
    return { data: await this._getErrorCard(schema, route, notFoundErrorCardId) };
  }
});

function hasUnconsumedPath(path, cardContext) {
  if (path.charAt(0) === '/') { return true; }

  let { data: { type } } = cardContext;
  if (path.length && path.charAt(0) !== '?' && type === 'application-cards') { return true; }

  return path.charAt(0) === '?' &&
         decodeURI(path).match(new RegExp(`${type}\\[[^\\]]+\\]=`));
}

function buildPathFromRouteStack(routeStack) {
  return (routeStack || []).reduceRight((fullPath, parentRoute) => joinPath(fullPath, parentRoute.path), '');
}

function buildNameSpacedPathFromRouteStack(routeStack) {
  return (routeStack || []).reduceRight((fullPath, parentRoute) => joinPath(fullPath, parentRoute.path.replace(/(?!:card):([^/?&#]+)/g, `:$1[${parentRoute.contentType}]`)), '');
}

function joinPath(part1, part2) {
  let [ part1Path, part1QueryParams ] = part1.split('?');
  let [ part2Path, part2QueryParams ] = part2.split('?');
  if (part2Path === '/') {
    part2Path = part2Path.substring(1);
  }
  let path = part1Path + part2Path;
  let queryParams = `${(part1QueryParams || '')}${part2QueryParams ? '&' + part2QueryParams : ''}`;

  if (queryParams && queryParams.charAt(0) === '&') {
    queryParams = queryParams.substring(1);
  }

  return `${path}${queryParams ? '?' + queryParams : ''}`;
}