import Dexie from 'dexie';
import type { GPXFile } from 'gpx';
import { enableMapSet, enablePatches, type Patch } from 'immer';

enableMapSet();
enablePatches();

export type LiveFileHandleRecord = {
    fileId: string;
    handle: FileSystemFileHandle;
};

export class Database extends Dexie {
    fileids!: Dexie.Table<string, string>;
    files!: Dexie.Table<GPXFile, string>;
    patches!: Dexie.Table<{ patch: Patch[]; inversePatch: Patch[]; index: number }, number>;
    settings!: Dexie.Table<any, string>;
    livefilehandles!: Dexie.Table<LiveFileHandleRecord, string>;
    overpasstiles!: Dexie.Table<
        { query: string; x: number; y: number; time: number },
        [string, number, number]
    >;
    overpassdata!: Dexie.Table<
        { query: string; id: number; poi: GeoJSON.Feature },
        [string, number]
    >;

    constructor() {
        super('Database', {
            cache: 'immutable',
        });
        this.version(1).stores({
            fileids: ',&fileid',
            files: '',
            patches: ',patch',
            settings: '',
            overpasstiles: '[query+x+y],[x+y]',
            overpassdata: '[query+id]',
        });
        this.version(2).stores({
            fileids: ',&fileid',
            files: '',
            patches: ',patch',
            settings: '',
            livefilehandles: '&fileId',
            overpasstiles: '[query+x+y],[x+y]',
            overpassdata: '[query+id]',
            mediawikitiles: '[overlayId+x+y],[x+y]',
            mediawikidata: '[overlayId+pageUrl]',
        });
    }
}

export const db = new Database();
