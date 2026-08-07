import { readFileSync } from "node:fs";
import rhino3dm from "rhino3dm";

const rhino = await rhino3dm();
const bytes = new Uint8Array(readFileSync("c:/Users/tril/Downloads/74-bottle/BOTTLE.3dm"));
const doc = rhino.File3dm.fromByteArray(bytes);
const geo = doc.objects().get(0).geometry();

const ot = geo.objectType;
console.log("objectType value:", ot, typeof ot);
console.log("constructor.name:", ot?.constructor?.name);
console.log("three's derived label:", String(ot?.constructor?.name).substring(11));
console.log("rhino.ObjectType.Brep:", rhino.ObjectType.Brep, typeof rhino.ObjectType.Brep);
console.log("matches:", ot === rhino.ObjectType.Brep);
console.log("ObjectType keys sample:", Object.keys(rhino.ObjectType).slice(0, 8));
