// A named import, so the bundle carries the version string and nothing else from package.json.
import { version } from "../package.json";

export const NAME = "maccabi-health";
export const VERSION: string = version;
