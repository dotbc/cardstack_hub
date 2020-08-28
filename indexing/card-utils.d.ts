import Session from '@cardstack/plugin-utils/session';
import { todo } from '@cardstack/plugin-utils/todo-any';
import { SingleResourceDoc, ResourceObject, CollectionResourceDoc, AttributesObject } from "jsonapi-typescript";
declare function isCard(type?: string, id?: string): boolean | "";
declare function loadCard(schema: todo, card: SingleResourceDoc): Promise<ResourceObject<string, AttributesObject<{
    [k: string]: import("json-typescript").Value;
}>>[] | undefined>;
declare function getCardId(id: string | number | undefined): string | undefined;
declare function generateInternalCardFormat(schema: todo, card: SingleResourceDoc): {
    data: ResourceObject<string, AttributesObject<{
        [k: string]: import("json-typescript").Value;
    }>>;
    included: ResourceObject<string, AttributesObject<{
        [k: string]: import("json-typescript").Value;
    }>>[];
};
declare function adaptCardCollectionToFormat(schema: todo, session: Session, collection: CollectionResourceDoc, format: string, cardServices: todo): Promise<import("jsonapi-typescript").DocWithData<ResourceObject<string, {
    [k: string]: import("json-typescript").Value;
}>[]>>;
declare function adaptCardToFormat(schema: todo, session: Session, cardModel: SingleResourceDoc, format: string, cardServices: todo): Promise<import("jsonapi-typescript").DocWithData<ResourceObject<string, {
    [k: string]: import("json-typescript").Value;
}>>>;
declare const _default: {
    isCard: typeof isCard;
    loadCard: typeof loadCard;
    getCardId: typeof getCardId;
    adaptCardToFormat: typeof adaptCardToFormat;
    cardBrowserAssetFields: string[];
    generateInternalCardFormat: typeof generateInternalCardFormat;
    adaptCardCollectionToFormat: typeof adaptCardCollectionToFormat;
};
export = _default;
