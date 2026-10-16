import * as teleproto from "teleproto";
import type { LibLike } from "./features";

/** The one place the project imports the MTProto library module namespace, so swapping libraries is a local change. */
export const lib = teleproto;
export const libInfo = (): LibLike => teleproto as unknown as LibLike;
