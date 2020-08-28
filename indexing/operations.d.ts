import { Document } from 'jsonapi-typescript';
import { todo } from '@cardstack/plugin-utils/todo-any';
declare class Operations {
    static create(sourcesUpdate: todo, sourceId: string): Operations;
    constructor(sourcesUpdate: todo, sourceId: string);
    save(type: string, id: string, doc: Document): Promise<void>;
    delete(type: string, id: string): Promise<void>;
    beginReplaceAll(): Promise<void>;
    finishReplaceAll(): Promise<void>;
}
export = Operations;
