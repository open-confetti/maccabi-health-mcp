import type { SerializedCookieJar } from "tough-cookie";

/** A signed-in session as it is kept between runs. It is a credential: protected storage only, and never a log line. */
export interface PortalSession {
  format: 1;
  jar: SerializedCookieJar;
  signedInAt: string;
  bearer?: string;
}
