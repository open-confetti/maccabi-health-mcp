// The credentials the fake Maccabi issues. None occurs anywhere else, so finding one in a command's
// output, an MCP result or a saved file proves that it leaked from the session.
export const MARKERS = {
  jwt: "MOCKJWT5d0e",
  saml: "MOCKSAML88aa",
  preauthCookie: "MOCKPREAUTHCOOKIE21e9",
  sessionCookie: "MOCKSESSIONCOOKIE7f3a",
  apiToken: "MOCKAPITOKEN91bc",
};
