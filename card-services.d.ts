import Session from '@cardstack/plugin-utils/session';
declare const _default: {
    new (): {
        searchers: any;
        currentSchema: any;
        writers: any;
        get(session: Session, id: string, format: string): Promise<import("jsonapi-typescript").DocWithData<import("jsonapi-typescript").ResourceObject<string, {
            [k: string]: import("json-typescript").Value;
        }>>>;
        search(session: Session, format: string, query: any): Promise<import("jsonapi-typescript").DocWithData<import("jsonapi-typescript").ResourceObject<string, {
            [k: string]: import("json-typescript").Value;
        }>[]>>;
        create(session: Session, card: import("jsonapi-typescript").DocWithData<import("jsonapi-typescript").ResourceObject<string, {
            [k: string]: import("json-typescript").Value;
        }>>): Promise<any>;
        update(session: Session, id: string, card: import("jsonapi-typescript").DocWithData<import("jsonapi-typescript").ResourceObject<string, {
            [k: string]: import("json-typescript").Value;
        }>>): Promise<any>;
        delete(session: Session, id: string, version: string): Promise<any>;
    };
};
export = _default;
